/*
 * Display Mover
 * -------------
 * GNOME Shell 50 (Mutter 18 / Fedora 44) extension that moves windows of the
 * current workspace between physical displays from a panel menu.
 *
 * Design constraints (v1):
 *   - Pure Mutter API (Meta.Window.move_to_monitor). No wmctrl/xdotool/
 *     xrandr, no daemons, no CLI — safe for remote/RDP sessions.
 *   - Current workspace only; moving never changes the workspace.
 *   - Displays are enumerated dynamically (no hard-coded DP-3/HDMI-1/eDP-1).
 *   - NORMAL app windows only: shell windows, skip_taskbar, tooltips and
 *     minimized windows are excluded; sticky windows are included if visible.
 *   - Menu stays open after a move; current display marked with "✓",
 *     primary display with "★".
 *   - Errors are logged via console.error and never crash the shell.
 */

'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const TAG = 'Display Mover';

const STATUS_AREA_ROLE = 'display-mover';
const CSS_SECTION_NAME = 'display-mover';
const REFRESH_DEBOUNCE_MS = 100;
const TITLE_MAX_CHARS = 32;
const PANEL_ICON_NAME = 'video-display-symbolic';
const FALLBACK_ICON_NAME = 'application-x-executable-symbolic';
const ROW_ICON_SIZE = 22;

function log(msg, ...details) {
    console.info(`[${TAG}] ${msg}`, ...details);
}

function logError(msg, err) {
    const detail = (err && (err.stack || err.message)) || err;
    console.error(`[${TAG}] ${msg}`, detail);
}

function safeConnect(object, signal, handler, disconnectOn) {
    // A missing signal on this Mutter version must not kill the extension.
    try {
        return disconnectOn
            ? object.connectObject(signal, handler, disconnectOn)
            : object.connect(signal, handler);
    } catch (err) {
        return 0;
    }
}

export default class DisplayMoverExtension {
    // The shell passes the extension metadata object at construction time.
    constructor(metadata) {
        this.metadata = metadata ?? null;

        this._panelButton = null;
        this._menu = null;
        this._rowWidgets = [];

        this._cssScreen = null;
        this._cssId = 0;
        this._cssLoadToken = 0;

        this._debounceSource = 0;
        this._globalSignals = [];   // { object, id } pairs
        this._windowSignals = new Map(); // Meta.Window -> [ids]
    }

    // --------------------------------------------------------------- lifecycle

    enable() {
        this._enableStylesheet();
        this._createPanelButton();
        this._connectGlobalSignals();
        this._rebuildMenu();
    }

    disable() {
        this._cancelDebounce();
        this._disconnectGlobalSignals();
        this._disconnectWindowSignals();

        // Explicitly destroy every widget we created (header, separator,
        // scroller, rows). destroy() is idempotent-safe: the panel button
        // below would tear them down anyway, but this keeps disable()
        // self-contained (review rule EGO-L-002).
        for (const widget of this._rowWidgets) {
            try {
                widget.destroy();
            } catch (err) {
                // Already destroyed — ignore.
            }
        }
        this._rowWidgets = [];

        if (this._panelButton) {
            try {
                this._panelButton.destroy();
            } catch (err) {
                logError('destroy of panel button failed', err);
            }
            this._panelButton = null;
        }
        this._menu = null;

        this._disableStylesheet();
    }

    // --------------------------------------------------------------- stylesheet

    // Loads stylesheet.css asynchronously (never blocks the shell loop)
    // and registers it as a named CSS section. A completion token
    // invalidates in-flight loads when disable() runs first.
    _enableStylesheet() {
        let file;
        try {
            const base = this.metadata && (this.metadata['path'] || this.metadata['dir']);
            if (!base) {
                return;
            }
            file = Gio.File.new_for_path(`${base}/stylesheet.css`);
        } catch (err) {
            logError('could not open stylesheet.css', err);
            return;
        }

        const token = (this._cssLoadToken = (this._cssLoadToken || 0) + 1);
        try {
            file.load_contents_async(null, (source, result) => {
                let css = null;
                try {
                    // finish() must run even when the token is stale.
                    const [ok, contents] = source.load_contents_finish(result);
                    css = ok ? new TextDecoder().decode(contents) : null;
                } catch (err) {
                    logError('stylesheet.css load failed', err);
                    return;
                }
                if (token !== this._cssLoadToken || !css) {
                    return; // disabled in the meantime, or empty file
                }
                try {
                    const screen =
                        St.ThemeContext.get_for_stage(global.stage).get_screen();
                    this._cssScreen = screen;
                    this._cssId = screen.add_css_section(
                        CSS_SECTION_NAME, css, CSS_SECTION_NAME);
                } catch (err) {
                    logError('failed to register CSS section', err);
                    this._cssScreen = null;
                    this._cssId = 0;
                }
            });
        } catch (err) {
            logError('could not start stylesheet.css load', err);
        }
    }

    _disableStylesheet() {
        // Invalidate any in-flight async stylesheet load.
        this._cssLoadToken = (this._cssLoadToken || 0) + 1;
        if (this._cssScreen && this._cssId) {
            try {
                this._cssScreen.remove_css_section(this._cssId);
            } catch (err) {
                logError('failed to remove CSS section', err);
            }
        }
        this._cssScreen = null;
        this._cssId = 0;
    }

    // ---------------------------------------------------------- panel + menu

    _createPanelButton() {
        // Must be a PanelMenu.Button (the panel refuses anything else).
        const button = new PanelMenu.Button(1.0, 'Move windows between displays');
        button.add_child(new St.Icon({
            icon_name: PANEL_ICON_NAME,
            style_class: 'system-status-icon dm-panel-icon',
        }));

        this._panelButton = button;
        this._menu = button.menu; // PopupMenu; content container is menu.box

        Main.panel.addToStatusArea(STATUS_AREA_ROLE, button, 0, 'right');
    }

    // ------------------------------------------------------------------ signals

    _connectGlobalSignals() {
        const refresh = () => this._scheduleRebuild();
        const display = global.display;

        const bindings = [
            // Display hot-plug / change notifications (Mutter signal names).
            [display, 'monitor-connected'],
            [display, 'monitor-disconnected'],
            [display, 'monitor-changed'],
            [display, 'focus-in'],
            // Window churn (new windows / closed windows). Older Mutter used
            // shell-window-created/removed; these names are the current ones.
            [display, 'window-added'],
            [display, 'window-removed'],
            [global.workspace_manager, 'active-workspace-changed'],
        ];

        for (const [object, signal] of bindings) {
            const id = safeConnect(object, signal, refresh);
            if (id) {
                this._globalSignals.push({object, id});
            }
        }
    }

    _disconnectGlobalSignals() {
        for (const {object, id} of this._globalSignals) {
            try {
                object.disconnect(id);
            } catch (err) {
                // Object already gone (e.g. display recycled) — ignore.
            }
        }
        this._globalSignals = [];
    }

    _disconnectWindowSignals() {
        for (const [win, ids] of this._windowSignals) {
            try {
                win.disconnectObject(ids.filter(Boolean));
            } catch (err) {
                // Window is gone or signal already invalid — ignore.
            }
        }
        this._windowSignals.clear();
    }

    // ------------------------------------------------------------------ rebuild

    _scheduleRebuild() {
        if (this._debounceSource) {
            try {
                GLib.source_remove(this._debounceSource);
            } catch (err) {
                // Source already fired — ignore.
            }
        }
        this._debounceSource = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, REFRESH_DEBOUNCE_MS, () => {
                this._debounceSource = 0;
                this._rebuildMenu();
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelDebounce() {
        if (this._debounceSource) {
            try {
                GLib.source_remove(this._debounceSource);
            } catch (err) {
                // Already fired — ignore.
            }
        }
        this._debounceSource = 0;
    }

    _collectWindows() {
        const display = global.display;
        const activeWorkspace = global.workspace_manager.get_active_workspace();

        let windows = [];
        try {
            windows = activeWorkspace.list_windows();
            const sorted = display.sort_windows_by_stacking(windows);
            windows = sorted || windows;
        } catch (err) {
            logError('failed to list workspace windows', err);
            return [];
        }

        const kept = [];
        for (const win of windows) {
            try {
                // Application windows only (drops shell/desktop/tooltip/dock).
                if (win.get_window_type() !== Meta.WindowType.NORMAL) {
                    continue;
                }

                // Skip taskbar-exempt surfaces (tooltips, overlays, ...).
                if (win.is_skip_taskbar && win.is_skip_taskbar()) {
                    continue;
                }

                // v1: exclude minimized windows; sticky-but-visible stays.
                if (win.minimized) {
                    continue;
                }

                if (typeof win.showing_on_its_workspace === 'function'
                    && !win.showing_on_its_workspace()) {
                    continue;
                }
            } catch (err) {
                logError('skipping window that raised while probing', err);
                continue;
            }
            kept.push(win);
        }

        // Most-recently-used first, falling back to stacking order.
        try {
            kept.sort((a, b) => {
                const at = a.get_user_time ? a.get_user_time() : 0;
                const bt = b.get_user_time ? b.get_user_time() : 0;
                if (bt !== at) {
                    return bt - at;
                }
                const atitle = (a.get_title() || '').localeCompare
                    ? a.get_title() : '';
                const btitle = b.get_title() || '';
                return atitle.localeCompare(btitle);
            });
        } catch (err) {
            logError('MRU sort failed, keeping stacking order', err);
        }

        return kept;
    }

    _displayList() {
        // Meta 18 has no display.get_monitor_connector_name() / ...description()
        // accessors; display identity lives on the Meta.Monitor object itself.
        // `display.get_monitors()` is a GList whose position equals the display
        // index used by move_to_monitor(i) and win.get_monitor().
        const list = [];
        try {
            let node = global.display.get_monitors();
            while (node) {
                const dsp = node.data;
                let connector = '';
                let name = '';
                let isPrimary = false;
                try {
                    connector = dsp.get_connector() || '';
                } catch (err) {
                    // Connector property missing on this build.
                }
                try {
                    name = dsp.get_display_name()
                        || dsp.get_product()
                        || dsp.get_vendor()
                        || '';
                } catch (err) {
                    // Display name is decorative only.
                }
                try {
                    isPrimary = Boolean(dsp.is_primary());
                } catch (err) {
                    // Primary flag is decorative only.
                }
                list.push({connector, name, isPrimary});
                node = node.next;
            }
        } catch (err) {
            logError('get_monitors() failed', err);
        }

        if (list.length === 0) {
            // Last resort: index-only names — never crash the shell (spec §6).
            let n = 0;
            try {
                n = global.display.get_n_monitors();
            } catch (err) {
                n = 0;
            }
            if (isFinite(n) && n > 0) {
                for (let i = 0; i < n; ++i) {
                    list.push({connector: '', name: `Display ${i + 1}`, isPrimary: false});
                }
            } else {
                list.push({connector: '', name: 'Primary display', isPrimary: true});
            }
        }

        // Fallback primary detection by index, in case is_primary() was absent.
        if (!list.some(d => d.isPrimary)) {
            let primary = -1;
            try {
                primary = global.display.get_primary_monitor();
            } catch (err) {
                primary = -1;
            }
            if (primary >= 0 && primary < list.length) {
                list[primary] = {...list[primary], isPrimary: true};
            }
        }

        return list;
    }

    _rebuildMenu() {
        if (!this._menu || !this._menu.box) {
            return;
        }
        const box = this._menu.box;

        try {
            for (const child of box.get_children()) {
                try {
                    child.destroy();
                } catch (err) {
                    // Already destroyed — ignore.
                }
            }
        } catch (err) {
            logError('failed to clear menu contents', err);
            return;
        }

        this._disconnectWindowSignals();
        this._rowWidgets = [];

        let windows = [];
        try {
            windows = this._collectWindows();
        } catch (err) {
            windows = [];
        }

        const displays = this._displayList();

        // Header: workspace context + window count.
        const header = new St.Label({
            text: `Current workspace — ${windows.length} ${windows.length === 1 ? 'window' : 'windows'}`,
            style_class: 'dm-header',
        });
        box.add_child(header);
        this._rowWidgets.push(header);

        const separator = new St.Widget({
            style_class: 'dm-separator',
            x_expand: true,
        });
        box.add_child(separator);
        this._rowWidgets.push(separator);

        if (windows.length === 0) {
            const empty = new St.Label({
                text: 'No movable windows on this workspace.',
                style_class: 'dm-empty',
            });
            box.add_child(empty);
            this._rowWidgets.push(empty);
            return;
        }

        // Rows live in a scroller so long lists never overflow the panel menu.
        const rowsLayout = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'dm-rows',
        });
        const scroller = new St.ScrollView({
            style_class: 'dm-scroller',
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: rowsLayout,
        });

        for (const win of windows) {
            const row = this._buildRow(win, displays);
            if (row) {
                rowsLayout.add_child(row);
            }
        }

        box.add_child(scroller);
        this._rowWidgets.push(scroller);
    }

    _buildRow(win, displays) {
        try {
            const row = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'dm-row',
            });

            // ---- App icon (fallback: generic executable) ---------------
            let icon = null;
            try {
                const app = Shell.WindowTracker.get_default()
                    .get_window_app(win);
                if (app) {
                    icon = app.create_icon_texture(ROW_ICON_SIZE);
                }
            } catch (err) {
                logError('app icon lookup failed', err);
            }
            if (!icon) {
                icon = new St.Icon({
                    icon_name: FALLBACK_ICON_NAME,
                    style_class: 'dm-fallback-icon system-action-icon',
                });
            }
            try {
                icon.add_style_class_name('dm-app-icon');
            } catch (err) {
                // Non-St texture — styling is best-effort only.
            }
            row.add_child(icon);

            // ---- Title ---------------------------------------------------
            const title = new St.Label({
                text: this._windowTitle(win),
                style_class: 'dm-title',
            });
            // Let the title absorb free space and push the display buttons to
            // the right edge; overflow is truncated in JS (see _windowTitle).
            try {
                title.x_expand = true;
            } catch (err) {
                // Property not present on this St build — layout still works,
                // just without a right-aligned button group.
            }
            row.add_child(title);

            // ---- One button per connected display ------------------------
            let currentDisplay = -1;
            try {
                currentDisplay = win.get_monitor();
            } catch (err) {
                logError('get_monitor failed for a tracked window', err);
            }
            const primaryIndex = displays.findIndex(d => d.isPrimary);

            const buttonsLayout = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'dm-display-box',
            });

            for (let i = 0; i < displays.length; ++i) {
                const button = this._buildDisplayButton(
                    win, i, displays[i],
                    i === currentDisplay,
                    i === primaryIndex);
                if (button) {
                    buttonsLayout.add_child(button);
                }
            }
            row.add_child(buttonsLayout);

            // ---- Keep this window fresh (minimize/title/focus/move/kill) --
            const ids = [
                safeConnect(win, 'destroy', () => this._scheduleRebuild(), win),
                safeConnect(win, 'window-state-changed',
                            () => this._scheduleRebuild(), win),
                safeConnect(win, 'notify::minimized',
                            () => this._scheduleRebuild(), win),
                safeConnect(win, 'title-changed',
                            () => this._scheduleRebuild(), win),
                safeConnect(win, 'focus', () => this._scheduleRebuild(), win),
            ];
            this._windowSignals.set(win, ids.filter(Boolean));

            return row;
        } catch (err) {
            logError('failed to build a menu row', err);
            return null;
        }
    }

    _buildDisplayButton(win, displayIndex, dsp, isCurrent, isPrimary) {
        let label = dsp.connector || dsp.name || `Display ${displayIndex + 1}`;
        if (isCurrent) {
            label += ' ✓';
        }
        if (isPrimary) {
            label += ' ★';
        }

        const button = new St.Button({
            label,
            style_class: 'dm-display-btn'
                + (isCurrent ? ' dm-display-current' : '')
                + (isPrimary ? ' dm-primary' : ''),
        });

        // Tooltip: display name + connector + geometry (decorative).
        let tooltipParts = [];
        if (dsp.name) {
            tooltipParts.push(dsp.name);
        }
        if (dsp.connector && dsp.connector !== dsp.name) {
            tooltipParts.push(dsp.connector);
        }
        try {
            const geometry = global.display.get_monitor_geometry(displayIndex);
            if (geometry && geometry.width && geometry.height) {
                tooltipParts.push(`${geometry.width}×${geometry.height}`);
            }
        } catch (err) {
            // Geometry is decorative only.
        }
        const tooltip = tooltipParts.join(' · ');
        if (tooltip) {
            // Best-effort: tooltip_text is a Clutter actor property on recent
            // stacks; if unavailable, the button label already names the
            // display, and accessible_name remains as an a11y hint.
            try {
                button.tooltip_text = tooltip;
            } catch (err) {
                // No tooltip support — accepted for v1.
            }
            try {
                button.accessible_name = tooltip;
            } catch (err) {
                // Accessibility attributes are optional.
            }
        }

        button.connect('clicked', () => {
            this._moveWindow(win, displayIndex);
        });

        return button;
    }

    _windowTitle(win) {
        let title = '';
        try {
            title = win.get_title() || '';
        } catch (err) {
            title = '';
        }
        if (!title) {
            try {
                title = win.get_wm_class() || 'Window';
            } catch (err) {
                title = 'Window';
            }
        }
        title = title.trim();
        if (!title) {
            title = 'Window';
        }
        if (title.length > TITLE_MAX_CHARS) {
            title = `${title.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
        }
        return title;
    }

    // -------------------------------------------------------------------- move

    _moveWindow(win, displayIndex) {
        let windowTitle = '';
        try {
            windowTitle = win.get_title() || '<untitled>';
        } catch (err) {
            windowTitle = '<untitled>';
        }

        try {
            win.move_to_monitor(displayIndex);
            log(`moved "${windowTitle}" to display ${displayIndex}`);
        } catch (err) {
            logError(`move_to_monitor(${displayIndex}) failed for `
                + `"${windowTitle}" (letting Mutter decide)`, err);
        } finally {
            // Refresh state without closing the menu (spec §2) and without
            // touching the workspace.
            this._scheduleRebuild();
        }
    }
}
