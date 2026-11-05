import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SYSTEM_KEYBINDING_SCHEMA = 'org.gnome.desktop.wm.keybindings';
const CONFLICTING_SYSTEM_KEYS = [
    'switch-windows',
    'switch-windows-backward',
    'switch-applications',
    'switch-applications-backward',
];

// Порог быстрого переключения (в микросекундах)
const FAST_SWITCH_THRESHOLD_US = 120000; // 120 мс

function getWindows(settings) {
    const currentOnly = settings.get_boolean('current-workspace-only');
    const includeMinimized = settings.get_boolean('include-minimized');
    const activeWorkspace = global.workspace_manager.get_active_workspace();

    let windows = [];

    try {
        if (currentOnly) {
            windows = global.display.get_tab_list(Meta.TabList.NORMAL, activeWorkspace) || [];
        } else {
            const type = Meta.TabList.NORMAL_ALL ?? Meta.TabList.NORMAL;
            windows = global.display.get_tab_list(type, null) || [];
        }
    } catch (e) {
        if (currentOnly) {
            windows = activeWorkspace.list_windows();
        } else {
            windows = global.get_window_actors()
                .map(a => {
                    if (a.meta_window) return a.meta_window;
                    if (typeof a.get_meta_window === 'function') return a.get_meta_window();
                    return null;
                })
                .filter(w => w);
            windows.sort((a, b) => b.get_user_time() - a.get_user_time());
        }
    }

    return windows.filter(w => {
        if (!w || w.is_skip_taskbar()) return false;
        if (w.get_window_type() !== Meta.WindowType.NORMAL) return false;
        if (!includeMinimized && w.minimized) return false;
        return true;
    });
}

const WindowSwitcherPopup = GObject.registerClass(
class WindowSwitcherPopup extends St.Widget {
    _init(settings) {
        super._init({
            style_class: 'alttab-overlay',
            reactive: true,
            can_focus: true,
            visible: false,
            layout_manager: new Clutter.BinLayout(),
            x: 0,
            y: 0,
        });

        this._settings = settings;
        this._windows = [];
        this._items = [];
        this._selectedIndex = -1;
        this._columns = 1;
        this._haveModal = false;
        this._destroyed = false;
        this._lastSwitchTime = 0;
        this._windowSignals = new Map();
        this._keyPressId = 0;
        this._keyReleaseId = 0;
        this._pollTimeoutId = 0;
        this._showTime = 0;
        this._workAreaWidth = 0;
        this._workAreaHeight = 0;

        this._container = new St.BoxLayout({
            style_class: 'alttab-window-switcher',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._container.spacing = 14;
        this._container.layout_manager.orientation = Clutter.Orientation.VERTICAL;

        this._grid = new St.Widget({
            style_class: 'alttab-grid',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const flowLayout = new Clutter.FlowLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            homogeneous: false,
        });
        flowLayout.column_spacing = 20;
        flowLayout.row_spacing = 20;
        this._grid.layout_manager = flowLayout;

        this._container.add_child(this._grid);
        this.add_child(this._container);

        this.connect('destroy', () => this._onDestroy());
    }

    show(backward) {
        this._windows = getWindows(this._settings);

        if (!this._windows.length) {
            this.destroy();
            return;
        }

        const monitor = Main.layoutManager.currentMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);

        this._workAreaWidth = workArea.width;
        this._workAreaHeight = workArea.height;

        Main.uiGroup.add_child(this);
        this.set_position(workArea.x, workArea.y);
        this.set_size(workArea.width, workArea.height);

        this._buildItems();

        const count = this._items.length;
        if (backward) {
            this._select(count - 1);
        } else {
            this._select(count > 1 ? 1 : 0);
        }

        this.visible = true;

        if (!Main.pushModal(this, { actionMode: Shell.ActionMode.ALL })) {
            this.destroy();
            return;
        }

        this._haveModal = true;
        this._showTime = GLib.get_monotonic_time();

        this._keyPressId = global.stage.connect('key-press-event', this._onKeyPress.bind(this));
        this._keyReleaseId = global.stage.connect('key-release-event', this._onKeyRelease.bind(this));

        this.grab_key_focus();

        this._pollTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
            if (this._destroyed) return GLib.SOURCE_REMOVE;

            try {
                const [x, y, mods] = global.get_pointer();
                const mask = Clutter.ModifierType.MODIFIER_MASK &
                             ~Clutter.ModifierType.LOCK_MASK &
                             ~Clutter.ModifierType.MOD2_MASK;
                
                if ((mods & mask) === 0) {
                    this._finish(true);
                    return GLib.SOURCE_REMOVE;
                }
            } catch (e) {
                // ignore
            }
            
            return GLib.SOURCE_CONTINUE;
        });
    }

    handleSwitch(backward) {
        this._requestSwitch(backward);
    }

    _requestSwitch(backward) {
        const now = GLib.get_monotonic_time();
        if (this._lastSwitchTime && now - this._lastSwitchTime < 50000) return;

        this._lastSwitchTime = now;
        this._selectRelative(backward ? -1 : 1);
    }

    _buildItems() {
        this._disconnectWindowSignals();
        this._grid.remove_all_children();
        this._items = [];
        this._selectedIndex = -1;

        const maxThumbWidth = Math.floor(this._workAreaWidth * 0.30);
        const maxThumbHeight = Math.floor(this._workAreaHeight * 0.30);

        this._thumbWidth = Math.max(192, Math.min(this._settings.get_int('thumbnail-width'), maxThumbWidth));
        this._thumbHeight = Math.max(120, Math.min(this._settings.get_int('thumbnail-height'), maxThumbHeight));

        this._itemWidth = this._thumbWidth + 28;
        this._itemHeight = this._thumbHeight + 76;

        const tracker = Shell.WindowTracker.get_default();

        for (const win of this._windows) {
            const item = new St.Widget({
                style_class: 'alttab-window-item',
                reactive: true,
                can_focus: true,
            });

            const itemLayout = new Clutter.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
            });
            itemLayout.spacing = 10;
            item.layout_manager = itemLayout;

            item.set_size(this._itemWidth, this._itemHeight);

            const thumbBin = new St.Bin({
                style_class: 'alttab-thumbnail',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                width: this._thumbWidth,
                height: this._thumbHeight,
                y_expand: true,
            });
            thumbBin.set_child(this._createThumbnail(win));

            const titleBox = new St.BoxLayout({
                style_class: 'alttab-title-box',
                x_align: Clutter.ActorAlign.CENTER,
                width: this._thumbWidth,
            });
            titleBox.spacing = 10;
            titleBox.layout_manager.orientation = Clutter.Orientation.HORIZONTAL;

            let iconActor = null;
            try {
                const app = tracker.get_window_app(win);
                if (app) iconActor = app.create_icon_texture(28);
            } catch (e) {
                iconActor = null;
            }

            if (!iconActor) {
                iconActor = new St.Icon({
                    icon_name: 'application-x-executable',
                    icon_size: 28,
                    style_class: 'alttab-app-icon',
                });
            }

            const title = new St.Label({
                text: win.get_title() || win.get_wm_class() || '',
                style_class: 'alttab-title',
            });
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            title.clutter_text.line_wrap = false;
            title.width = Math.max(56, this._thumbWidth - 52);

            titleBox.add_child(iconActor);
            titleBox.add_child(title);

            item.add_child(thumbBin);
            item.add_child(titleBox);

            const itemObj = { window: win, actor: item };

            item.connect('button-press-event', () => {
                const idx = this._items.indexOf(itemObj);
                if (idx !== -1) this._select(idx);
                this._finish(true);
                return Clutter.EVENT_STOP;
            });

            item.connect('notify::hover', () => {
                if (item.hover) {
                    const idx = this._items.indexOf(itemObj);
                    if (idx !== -1) this._select(idx);
                }
            });

            this._grid.add_child(item);
            this._items.push(itemObj);

            try {
                const id = win.connect('unmanaged', () => this._onWindowRemoved(win));
                this._windowSignals.set(win, id);
            } catch (e) {
                // ignore
            }
        }

        this._updateLayoutWidth();
    }

    _createThumbnail(win) {
        const fallbackIconSize = Math.min(116, Math.floor(this._thumbHeight / 2));

        try {
            const windowActor = win.get_compositor_private();
            if (windowActor && !win.minimized && windowActor.is_mapped()) {
                const rect = win.get_frame_rect();
                if (rect && rect.width > 0 && rect.height > 0) {
                    const scale = Math.min(
                        this._thumbWidth / rect.width,
                        this._thumbHeight / rect.height
                    );
                    const width = Math.max(1, Math.round(rect.width * scale));
                    const height = Math.max(1, Math.round(rect.height * scale));

                    return new Clutter.Clone({
                        source: windowActor,
                        width,
                        height,
                        reactive: false,
                    });
                }
            }
        } catch (e) {
            // fall through to icon fallback
        }

        try {
            const app = Shell.WindowTracker.get_default().get_window_app(win);
            if (app) {
                const icon = app.create_icon_texture(fallbackIconSize);
                if (icon) return icon;
            }
        } catch (e) {
            // fall through
        }

        return new St.Icon({
            icon_name: 'application-x-executable',
            icon_size: fallbackIconSize,
            style_class: 'alttab-fallback-icon',
        });
    }

    _updateLayoutWidth() {
        const spacing = 20;
        const containerPadding = 56;
        const maxTotalWidth = Math.floor(this._workAreaWidth * 0.92);
        const availableGridWidth = maxTotalWidth - containerPadding;

        const maxAvailableCols = Math.max(1, Math.floor((availableGridWidth + spacing) / (this._itemWidth + spacing)));
        const hardMaxCols = Math.min(8, this._items.length);
        const maxCols = Math.min(maxAvailableCols, hardMaxCols);

        let columns;
        let rows;

        if (this._items.length <= maxCols) {
            columns = this._items.length;
            rows = 1;
        } else {
            columns = Math.ceil(this._items.length / 2);
            columns = Math.min(columns, maxCols);
            rows = Math.ceil(this._items.length / columns);

            if (rows > 3) {
                columns = maxCols;
                rows = Math.ceil(this._items.length / columns);
            }
        }

        this._columns = columns;

        const gridWidth = columns * (this._itemWidth + spacing) - spacing;
        const gridHeight = rows * (this._itemHeight + spacing) - spacing;

        this._grid.width = gridWidth;
        this._container.width = gridWidth + containerPadding;
        this._container.height = gridHeight + containerPadding;
    }

    _select(index) {
        const count = this._items.length;
        if (!count) return;

        index = ((index % count) + count) % count;
        if (index === this._selectedIndex) return;

        if (this._selectedIndex >= 0 && this._items[this._selectedIndex]) {
            this._items[this._selectedIndex].actor.remove_style_class_name('selected');
        }

        this._selectedIndex = index;
        const item = this._items[index];
        item.actor.add_style_class_name('selected');
    }

    _selectRelative(delta) {
        this._select(this._selectedIndex + delta);
    }

    _onKeyPress(actor, event) {
        if (this._destroyed) return Clutter.EVENT_PROPAGATE;

        const symbol = event.get_key_symbol();
        const state = event.get_state();

        if (symbol === Clutter.KEY_Escape) {
            this._finish(false);
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter || symbol === Clutter.KEY_ISO_Enter) {
            this._finish(true);
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab) {
            const backward = symbol === Clutter.KEY_ISO_Left_Tab || (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
            this._requestSwitch(backward);
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Left) {
            this._selectRelative(-1);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Right) {
            this._selectRelative(1);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Up) {
            this._selectRelative(-this._columns);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Down) {
            this._selectRelative(this._columns);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onKeyRelease(actor, event) {
        if (this._destroyed) return Clutter.EVENT_PROPAGATE;

        const symbol = event.get_key_symbol();
        
        // Список клавиш-модификаторов, отпускание которых завершает переключение
        const finishSymbols = [
            Clutter.KEY_Alt_L, Clutter.KEY_Alt_R,
            Clutter.KEY_Meta_L, Clutter.KEY_Meta_R,
            Clutter.KEY_Super_L, Clutter.KEY_Super_R,
            Clutter.KEY_Hyper_L, Clutter.KEY_Hyper_R,
            Clutter.KEY_ISO_Level3_Shift,
        ];

        if (finishSymbols.includes(symbol)) {
            this._finish(true);
            return Clutter.EVENT_STOP;
        }

        // Fallback: проверяем глобальное состояние модификаторов
        // На случай если символ не совпал (например, другая раскладка)
        try {
            const [x, y, mods] = global.get_pointer();
            const mask = Clutter.ModifierType.MODIFIER_MASK &
                         ~Clutter.ModifierType.LOCK_MASK &
                         ~Clutter.ModifierType.MOD2_MASK;
            
            if ((mods & mask) === 0) {
                this._finish(true);
                return Clutter.EVENT_STOP;
            }
        } catch (e) {
            // ignore
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onWindowRemoved(win) {
        if (this._destroyed) return;
        const idx = this._windows.indexOf(win);
        if (idx === -1) return;

        const oldSelectedIndex = this._selectedIndex;
        const selectedWindow = this._items[this._selectedIndex]?.window ?? null;

        this._windows.splice(idx, 1);

        if (!this._windows.length) {
            this._finish(false);
            return;
        }

        this._buildItems();

        let newIndex = 0;
        if (selectedWindow && selectedWindow !== win && this._windows.includes(selectedWindow)) {
            newIndex = this._windows.indexOf(selectedWindow);
        } else {
            newIndex = Math.min(oldSelectedIndex >= 0 ? oldSelectedIndex : 0, this._windows.length - 1);
        }
        this._select(newIndex);
    }

    _finish(activate) {
        if (this._destroyed) return;

        const selected = this._items[this._selectedIndex] ?? null;
        const windowToActivate = activate ? selected?.window : null;

        const timestamp = global.get_current_time();

        this.destroy();

        if (windowToActivate) {
            Main.activateWindow(windowToActivate, timestamp);
        }
    }

    _disconnectWindowSignals() {
        for (const [win, id] of this._windowSignals) {
            try { win.disconnect(id); } catch (e) {}
        }
        this._windowSignals.clear();
    }

    _onDestroy() {
        if (this._destroyed) return;
        this._destroyed = true;

        if (this._pollTimeoutId) {
            GLib.source_remove(this._pollTimeoutId);
            this._pollTimeoutId = 0;
        }

        if (this._keyPressId) {
            try { global.stage.disconnect(this._keyPressId); } catch (e) {}
            this._keyPressId = 0;
        }
        if (this._keyReleaseId) {
            try { global.stage.disconnect(this._keyReleaseId); } catch (e) {}
            this._keyReleaseId = 0;
        }

        this._disconnectWindowSignals();

        if (this._haveModal) {
            try { Main.popModal(this); } catch (e) {}
            this._haveModal = false;
        }
    }
}
);

export default class AltTabWindowsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._popup = null;
        this._systemKeySettings = null;
        
        // Переменные для отслеживания быстрого нажатия
        this._fastSwitchTimerId = 0;
        this._pendingDirection = false;
        this._stageKeyPressId = 0;
        this._stageKeyReleaseId = 0;

        if (this._settings.get_boolean('override-default-alt-tab')) {
            this._disableConflictingSystemKeybindings();
        }

        // Вместо addKeybinding мы слушаем события напрямую на stage,
        // чтобы иметь полный контроль над временем реакции.
        // Но чтобы не ломать другие хоткеи, мы используем addKeybinding для регистрации,
        // но внутри него будем решать, что делать.
        
        try {
            Main.wm.addKeybinding(
                'forward',
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                () => this._handleSwitchRequest(false)
            );
        } catch (e) {
            logError(e, 'AltTabWindows: failed to bind forward keybinding');
        }

        try {
            Main.wm.addKeybinding(
                'backward',
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                () => this._handleSwitchRequest(true)
            );
        } catch (e) {
            logError(e, 'AltTabWindows: failed to bind backward keybinding');
        }
    }

    disable() {
        if (this._fastSwitchTimerId) {
            GLib.source_remove(this._fastSwitchTimerId);
            this._fastSwitchTimerId = 0;
        }

        this._closePopup();
        try { Main.wm.removeKeybinding('forward'); } catch (e) {}
        try { Main.wm.removeKeybinding('backward'); } catch (e) {}

        if (this._settings && this._settings.get_boolean('override-default-alt-tab')) {
            this._restoreSystemKeybindings();
        }

        this._settings = null;
        this._popup = null;
        this._systemKeySettings = null;
    }

    _closePopup() {
        if (this._popup) {
            this._popup.destroy();
            this._popup = null;
        }
    }

    _handleSwitchRequest(backward) {
        // Если попап уже есть, просто переключаем
        if (this._popup) {
            this._popup.handleSwitch(backward);
            return;
        }

        // Если таймер уже запущен, просто обновляем направление
        if (this._fastSwitchTimerId) {
            this._pendingDirection = backward;
            return;
        }

        // Запускаем таймер ожидания
        this._pendingDirection = backward;
        this._fastSwitchTimerId = GLib.timeout_add(
            GLib.PRIORITY_HIGH,
            Math.floor(FAST_SWITCH_THRESHOLD_US / 1000),
            () => {
                this._fastSwitchTimerId = 0;
                
                // Проверяем, отпущен ли Alt к этому моменту
                // Используем прямой опрос состояния клавиш через XInput/Wayland API, если доступно,
                // но в JS у нас только get_pointer. 
                // Однако, главное преимущество здесь в том, что мы ЖДЕМ перед созданием попапа.
                
                // Попробуем проверить состояние еще раз
                const [x, y, mods] = global.get_pointer();
                const mask = Clutter.ModifierType.MODIFIER_MASK &
                             ~Clutter.ModifierType.LOCK_MASK &
                             ~Clutter.ModifierType.MOD2_MASK;
                
                if ((mods & mask) === 0) {
                    // Мгновенное переключение
                    this._instantSwitch(this._pendingDirection);
                } else {
                    // Показываем попап
                    this._showPopup(this._pendingDirection);
                }
                
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _instantSwitch(backward) {
        const windows = getWindows(this._settings);
        if (!windows.length) return;

        let nextIndex;
        if (backward) {
            nextIndex = windows.length - 1;
        } else {
            nextIndex = windows.length > 1 ? 1 : 0;
        }

        Main.activateWindow(windows[nextIndex], global.get_current_time());
    }

    _showPopup(backward) {
        if (this._popup) {
            this._popup.handleSwitch(backward);
            return;
        }

        const popup = new WindowSwitcherPopup(this._settings);
        popup.connect('destroy', () => {
            if (this._popup === popup) this._popup = null;
        });

        this._popup = popup;
        popup.show(backward);
    }

    _getOwnAccelerators() {
        try {
            const accels = [...this._settings.get_strv('forward'), ...this._settings.get_strv('backward')];
            return new Set(accels.filter(a => a && a.trim()).map(a => a.toLowerCase()));
        } catch (e) {
            return new Set();
        }
    }

    _disableConflictingSystemKeybindings() {
        try {
            this._systemKeySettings = new Gio.Settings({ schema_id: SYSTEM_KEYBINDING_SCHEMA });
        } catch (e) {
            return;
        }

        const ownAccelerators = this._getOwnAccelerators();
        if (!ownAccelerators.size) return;

        for (const key of CONFLICTING_SYSTEM_KEYS) {
            try {
                if (!this._systemKeySettings.settings_schema.has_key(key)) continue;

                const savedKey = `saved-${key}`;
                const current = this._systemKeySettings.get_strv(key);
                const effective = current.filter(a => a && a.trim());

                if (effective.length > 0) {
                    this._settings.set_strv(savedKey, current);
                    this._systemKeySettings.set_strv(key, []);
                }
            } catch (e) {
                logError(e, `AltTabWindows: failed to clear conflicting keybinding ${key}`);
            }
        }
    }

    _restoreSystemKeybindings() {
        if (!this._systemKeySettings) {
            try {
                this._systemKeySettings = new Gio.Settings({ schema_id: SYSTEM_KEYBINDING_SCHEMA });
            } catch (e) {
                return;
            }
        }

        for (const key of CONFLICTING_SYSTEM_KEYS) {
            try {
                if (!this._systemKeySettings.settings_schema.has_key(key)) continue;

                const savedKey = `saved-${key}`;
                const saved = this._settings.get_strv(savedKey);

                if (saved && saved.length > 0) {
                    this._systemKeySettings.set_strv(key, saved);
                    this._settings.set_strv(savedKey, []);
                }
            } catch (e) {
                logError(e, `AltTabWindows: failed to restore keybinding ${key}`);
            }
        }
    }
}