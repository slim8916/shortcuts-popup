import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Pango from 'gi://Pango';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import * as Common from './common.js';

export default class ShortcutsPopupExtension extends Extension {
	// Define GObject classes as static properties to avoid module-level state
	static StatusIcon = GObject.registerClass(
		class StatusIcon extends PanelMenu.Button {
			_init(extension, isIconHidden, filesDir) {
				super._init(0.0, 'Status Icon');
				this.extension = extension;
				if (!isIconHidden) {
					const icon = new St.Icon({ gicon: Gio.icon_new_for_string(GLib.build_filenamev([filesDir, 'icon.png'])) });
					this.add_child(icon);
				}
				this.connect('button-press-event', () => this.extension.openLayoutShortcuts());
			}
		}
	);

	static FullscreenWidget = GObject.registerClass(
		class FullscreenWidget extends St.Widget {
			_init(extension) {
				super._init({
					style_class: 'fullscreen-overlay',
					reactive: true,
					can_focus: true,
					track_hover: true,
					layout_manager: new Clutter.BinLayout(),
				});
				this.extension = extension;
				this.set_style('background-color: rgba(0,0,0,0.8); pointer-events: all; z-index: 99999;');
				const monitor = Main.layoutManager.monitors[0];
				this.set_size(monitor.width, monitor.height);
				this.set_position(monitor.x, monitor.y);
				this.scrollView = new St.ScrollView({
					hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.NEVER,
					x_expand: true, y_expand: true
				});
				if (!this.extension.firstLaunch && !this.extension.parentBox.isError) {
					try {
						this.extension.resetSearchEntry();
					} catch (e) {
						log(e.message);
					}
				}
				this.scrollView.set_child(this.extension.parentBox);
				this.add_child(this.scrollView);
				if (this.extension.firstLaunch) this.extension.buildLayout(monitor.width);
				this.connect('button-press-event', () => {
					this.scrollView.set_child(null);
					this.extension.fullscreenOverlay.destroy();
					this.extension.fullscreenOverlay = null;
					return Clutter.EVENT_STOP;
				});
				this.connect("key-press-event", (_, event) => {
					if (event.get_key_symbol() === Clutter.KEY_Escape) {
						this.scrollView.set_child(null);
						this.extension.fullscreenOverlay.destroy();
						this.extension.fullscreenOverlay = null;
						return Clutter.EVENT_STOP;
					}
					return Clutter.EVENT_PROPAGATE;
				});
				this.grab_key_focus();
				if (this.extension.firstLaunch) {
					this.connect('notify::allocation', () => {
						this.extension.updateShortcutsByRanks(this.extension.indicesToUpdate);
						const columns = this.extension.createColumns();
						this.extension.createComponents(columns);
						this.extension.firstLaunch = false;
						this.extension.freeMemory();
					});
				}
			}
		}
	);
	constructor(metadata) {
		super(metadata);
		// No initialization here per EGO review guidelines
	}

	enable() {
		// Initialize common module
		Common.initCommon(this);

		// Get filesDir after initializing common
		this.filesDir = GLib.build_filenamev([this.path, 'files']);

		// Create settings instance (must be done in enable(), not at module level)
		this.settings = this.getSettings();

		// Initialize instance variables
		this.indicesToUpdate = [];
		this.firstLaunch = true;
		this.parentBox = null;
		this.searchEntry = null;
		this.numberCols = this.settings.get_int('number-cols');
		this.isIconHidden = this.settings.get_boolean('hide-icon');
		this.fileMonitor = null;
		this.colors = null;
		this.resultReadJsonFile = null;
		this.processedJson = null;
		this.style = null;
		this.statusIcon = null;
		this.fullscreenOverlay = null;

		// Set up file monitoring
		const shortcutsJsonFile = Gio.File.new_for_path(GLib.build_filenamev([this.filesDir, 'shortcuts.json']));
		try {
			this.fileMonitor = shortcutsJsonFile.monitor(Gio.FileMonitorFlags.NONE, null);
			this.fileMonitor.connect("changed", (_monitor, _file, _otherFile, eventType) => {
				switch (eventType) {
					case Gio.FileMonitorEvent.CREATED:
					case Gio.FileMonitorEvent.CHANGED:
					case Gio.FileMonitorEvent.DELETED:
						this.resetlayout().catch(e => log("Error in resetlayout: " + e.message));
						break;
				}
			});
		} catch (error) {
			log("Error monitoring file: " + error.message);
		}

		// Initialize parent box and layout
		this.parentBox = new St.BoxLayout({ vertical: true, x_expand: true, });
		this.resetlayout().catch(e => log("Error in resetlayout: " + e.message));

		// Connect settings change handlers
		this.settings.connect('changed::hide-icon', () => {
			this.isIconHidden = this.settings.get_boolean('hide-icon');
			this.resetlayout().catch(e => log("Error in resetlayout: " + e.message));
		});
		this.settings.connect('changed::number-cols', () => {
			this.numberCols = this.settings.get_int('number-cols');
			this.resetlayout().catch(e => log("Error in resetlayout: " + e.message));
		});
		this.settings.connect('changed::font-size', () => {
			this.style.shortcut.entryFontSize = this.settings.get_int('font-size');
			this.resetlayout().catch(e => log("Error in resetlayout: " + e.message));
		});

		// Create status icon and add to panel
		this.statusIcon = new ShortcutsPopupExtension.StatusIcon(this, this.isIconHidden, this.filesDir);
		Main.panel.addToStatusArea('status-icon', this.statusIcon);

		// Add keybinding
		Main.wm.addKeybinding(
			'shortcuts-toggle-overview',
			this.settings,
			Meta.KeyBindingFlags.NONE,
			Shell.ActionMode.ALL,
			() => this.openLayoutShortcuts()
		);
	}

	disable() {
		// Remove keybinding
		Main.wm.removeKeybinding('shortcuts-toggle-overview');

		// Cleanup file monitor
		if (this.fileMonitor) {
			this.fileMonitor.cancel();
			this.fileMonitor = null;
		}

		// Cleanup parent box
		if (this.parentBox) {
			this.parentBox.destroy();
			this.parentBox = null;
		}

		// Cleanup status icon
		if (this.statusIcon) {
			this.statusIcon.destroy();
			this.statusIcon = null;
		}

		// Cleanup fullscreen overlay
		if (this.fullscreenOverlay) {
			Main.popModal(this.fullscreenOverlay);
			this.fullscreenOverlay.destroy();
			this.fullscreenOverlay = null;
		}

		// Cleanup settings
		if (this.settings) {
			this.settings = null;
		}

		// Null out all instance variables
		this.indicesToUpdate = null;
		this.firstLaunch = null;
		this.searchEntry = null;
		this.numberCols = null;
		this.isIconHidden = null;
		this.colors = null;
		this.resultReadJsonFile = null;
		this.processedJson = null;
		this.style = null;

		// Cleanup common module
		Common.uninit();
	}

	openLayoutShortcuts() {
		if (!this.fullscreenOverlay) {
			this.fullscreenOverlay = new ShortcutsPopupExtension.FullscreenWidget(this);
			Main.uiGroup.add_child(this.fullscreenOverlay);
			Main.pushModal(this.fullscreenOverlay);
			this.fullscreenOverlay.grab_key_focus();
		}
	}

	resetSearchEntry() {
		if (this.searchEntry) {
			this.searchEntry.set_text('');
			GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
				this.searchEntry.grab_key_focus();
				return GLib.SOURCE_REMOVE;
			});
		}
	}

	async resetlayout() {
		this.firstLaunch = true;
		this.resultReadJsonFile = await Common.readShortcutsJson();
		this.colors = this.generateDarkSpectrumColorsHex(this.resultReadJsonFile.length);
	}

	freeMemory() {
		this.resultReadJsonFile = null;
		this.processedJson = null;
		this.colors = null;
		this.style = null;
	}

	buildLayout(totalWidth) {
		if (typeof this.resultReadJsonFile === 'string') {
			this.parentBox.remove_all_children();
			const label = new St.Label({
				text: `\nError: ${this.resultReadJsonFile}.\n\nPlease ensure that your JSON matches the structure specified in the README file located in the extension directory.`,
				style: 'font-size: 28px; color: white; margin: 20px; text-align: center;', x_expand: true,
				y_align: Clutter.ActorAlign.CENTER,
			});
			this.parentBox.add_child(label);
			this.parentBox.queue_relayout();
			this.parentBox.isError = true;
			this.freeMemory();
		} else {
			this.loadStyle(totalWidth);
			this.processJsonFile();
			const columns = this.createColumns();
			this.createComponents(columns);
		}
	}

	processJsonFile() {
		this.processedJson = this.resultReadJsonFile.flatMap(app =>
			app.types.flatMap(type => ({
				appName: app.name,
				typeName: type.name,
				shortcuts: type.shortcuts.map(shortcut => {
					return {
						key: shortcut.key,
						description: shortcut.description,
						height: this.style.shortcut.entryHeight
					};
				})
			}))
		);
	}

	createColumns() {
		const computeTotalHeight = (jsonArr) => {
			let totalHeight = 0;
			jsonArr.forEach(entry => entry.shortcuts.forEach(shortcut => totalHeight += shortcut.height));
			totalHeight += jsonArr.length * this.style.shortcut.typeHeight;
			return totalHeight;
		};
		let targetHeight = 0;
		let remainingShortcuts = this.processedJson.slice();
		let columns = [];
		let iter = 0;
		while (remainingShortcuts.length > 0 && iter < 10) {
			targetHeight = targetHeight + (computeTotalHeight(remainingShortcuts) / this.numberCols);
			remainingShortcuts = this.processedJson.slice();
			columns = [];
			for (let i = 0; i < this.numberCols; i++) {
				let currentHeight = 0;
				const column = [];
				while (currentHeight < targetHeight && remainingShortcuts.length > 0) {
					const entry = remainingShortcuts[0];
					const entryToCopy = { appName: entry.appName, typeName: entry.typeName, shortcuts: [] };
					const entryToKeep = { appName: entry.appName, typeName: entry.typeName + ' (Continued)', shortcuts: [] };
					for (let j = 0; j < entry.shortcuts.length; j++) {
						const shortcut = entry.shortcuts[j];
						if (currentHeight < targetHeight) {
							entryToCopy.shortcuts.push(shortcut);
							currentHeight += shortcut.height;
							if (j === 0) currentHeight += this.style.shortcut.typeHeight + 2 * this.style.shortcut.typeMargin;
						} else {
							entryToKeep.shortcuts.push(shortcut);
						}
					}
					if (entryToCopy.shortcuts.length > 0) remainingShortcuts.shift();
					if (entryToKeep.shortcuts.length > 0) remainingShortcuts.unshift(entryToKeep);
					column.push(entryToCopy);
				}
				columns.push(column);
			}
			iter++;
		}
		return columns;
	}

	loadStyle(totalWidth) {
		const adjustHeaderFontSize = 6;
		this.style = { column: { margin: 8, }, shortcut: { typePadding: 16, typeMargin: 24 } };
		this.style.column.width = Math.round(totalWidth / this.numberCols) - 2 * this.style.column.margin;
		this.style.shortcut.entryFontSize = this.settings.get_int('font-size');
		this.style.shortcut.typeFontSize = this.style.shortcut.entryFontSize + adjustHeaderFontSize;
		this.style.shortcut.entryHeight = this.computeLabelHeight('Sample Text', this.style.shortcut.entryFontSize);
		this.style.shortcut.typeHeight = this.computeLabelHeight('Sample Text', this.style.shortcut.typeFontSize);
		this.style.shortcut.keyLabelWidth = Math.ceil((this.style.column.width - 2 * this.style.shortcut.typePadding) * 0.35);
	}

	computeLabelHeight(text, fontSize) {
		const label = new St.Label({ text: text });
		const layout = Pango.Layout.new(label.clutter_text.get_pango_context());
		layout.set_text(text, -1);
		const fd = Pango.FontDescription.from_string("Sans Bold");
		fd.set_size(fontSize * Pango.SCALE);
		layout.set_font_description(fd);
		return Math.round(0.57 * layout.get_pixel_size()[1]);
	}

	generateDarkSpectrumColorsHex(n) {
		const hslToHex = (h, s, l) => {
			s /= 100;
			l /= 100;
			const c = (1 - Math.abs(2 * l - 1)) * s;
			const x = c * (1 - Math.abs((h / 60) % 2 - 1));
			const m = l - c / 2;
			let r, g, b;

			if (0 <= h && h < 60) [r, g, b] = [c, x, 0];
			else if (60 <= h && h < 120) [r, g, b] = [x, c, 0];
			else if (120 <= h && h < 180) [r, g, b] = [0, c, x];
			else if (180 <= h && h < 240) [r, g, b] = [0, x, c];
			else if (240 <= h && h < 300) [r, g, b] = [x, 0, c];
			else[r, g, b] = [c, 0, x];

			r = Math.round((r + m) * 255);
			g = Math.round((g + m) * 255);
			b = Math.round((b + m) * 255);

			return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
		};
		const colors = [];
		const startHue = 0;
		const endHue = 275;
		const lightness = 18;
		const saturation = 90;
		for (let i = 0; i < n; i++) {
			const hue = startHue + (i / (n - 1)) * (endHue - startHue);
			colors.push(hslToHex(hue, saturation, lightness));
		}
		return colors;
	}




	createComponents(columns) {
		this.parentBox.remove_all_children();
		this.parentBox.isError = false;
		const rowSearch = new St.BoxLayout({ vertical: false, x_expand: false, x_align: Clutter.ActorAlign.CENTER, style: `padding: 8px;`, });
		this.searchEntry = new St.Entry({
			x_expand: false, hint_text: "Search for...", can_focus: true,
			style: `background-color: black; padding: 16px; font-weight: bold; font-size: 20px; width: 400px;`
		});
		rowSearch.add_child(this.searchEntry);
		this.resetSearchEntry();
		this.searchEntry.connect("key-press-event", (_actor, event) => {
			const keyval = event.get_key_symbol();
			const keyString = getKeyString(keyval);

			if (keyString) {
				const oldText = this.searchEntry.get_text();
				if (!oldText.includes(keyString)) {
					this.searchEntry.set_text(oldText + (oldText ? " " : "") + keyString);
				}
			}
		});
		const getKeyString = (keyval) => {
			switch (keyval) {
				case Clutter.KEY_Shift_L:
				case Clutter.KEY_Shift_R:
					return "Shift";
				case Clutter.KEY_Control_L:
				case Clutter.KEY_Control_R:
					return "Ctrl";
				case Clutter.KEY_Alt_L:
				case Clutter.KEY_Alt_R:
					return "Alt";
				default:
					return null;
			}
		};
		this.searchEntry.clutter_text.connect("text-changed", () => {
			const searchTerms = this.searchEntry.get_text().trim().replace(/\s+/g, ' ').toLowerCase().split(/\s+/);
			shortcutsBox.get_children().forEach(columnBox => {
				columnBox.get_children().forEach(actor => {
					if (!(actor instanceof St.BoxLayout) || !actor.vertical) return;
					const typeBox = actor;
					const typeLabelBox = typeBox.get_previous_sibling();
					const typeLabel = typeLabelBox ? typeLabelBox.get_children()[0] : null;
					const typeText = typeLabel ? typeLabel.get_text().toLowerCase() : "";

					const typeNameMatches = searchTerms.every(term => typeText.includes(term));
					let hasVisibleShortcut = false;

					typeBox.get_children().forEach(shortcutBox => {
						const children = shortcutBox.get_children();
						const descText = children[0].get_text().toLowerCase();
						const keyText = children[1].get_text().toLowerCase();
						const descMatches = searchTerms.every(term => descText.includes(term));
						const keyMatches = searchTerms.every(term => keyText.includes(term));
						const shouldShowShortcut = typeNameMatches || keyMatches || descMatches;
						shortcutBox.visible = shouldShowShortcut;
						if (shouldShowShortcut)	hasVisibleShortcut = true;
					});

					typeBox.visible = hasVisibleShortcut || typeNameMatches;
					if (typeLabelBox) typeLabelBox.visible = typeBox.visible;
				});
			});
		});







		this.parentBox.add_child(rowSearch);
		const shortcutsBox = new St.BoxLayout({ vertical: false, x_expand: true, });
		this.parentBox.add_child(shortcutsBox);
		const typeStyle = `font-weight: bold; font-size: ${this.style.shortcut.typeFontSize}px; margin-top: ${this.style.shortcut.typeMargin}px; margin-bottom: ${this.style.shortcut.typeMargin}px;`;
		const entryStyle = `font-weight: bold; font-size: ${this.style.shortcut.entryFontSize}px`;
		let index = 0;
		const paddingEntry = 6;
		let currentApp = null;
		let appIndex = -1;
		columns.forEach(column => {
			const columnBox = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true, style: `margin: ${this.style.column.margin}px; width: ${this.style.column.width}px;` });
			column.forEach(typeGroup => {
				if (typeGroup.shortcuts.length === 0) return;
				if (currentApp !== typeGroup.appName) {
					currentApp = typeGroup.appName;
					appIndex++;
				}
				const typeLabelBox = new St.Widget({ layout_manager: new Clutter.BinLayout(), x_expand: true, });
				const typeLabel = new St.Label({ text: typeGroup.typeName, style: typeStyle });
				typeLabelBox.add_child(typeLabel);
				columnBox.add_child(typeLabelBox);
				const typeBox = new St.BoxLayout({
					vertical: true, x_expand: true, y_expand: true,
					style: `background-color: ${this.colors[appIndex]}; padding: ${this.style.shortcut.typePadding}px`
				});
				columnBox.add_child(typeBox);
				typeGroup.shortcuts.forEach(shortcut => {
					const shortcutBox = new St.BoxLayout({ vertical: false, x_expand: true, style: `height: ${shortcut.height}px; padding-top: 8px;` });
					const keyLabel = new St.Label({
						text: shortcut.key, y_expand: true,
						style: `${entryStyle}; width: ${this.style.shortcut.keyLabelWidth}px; padding-left: ${paddingEntry}px;`
					});
					shortcutBox.index = index;
					index += 1;
					keyLabel.clutter_text.line_wrap = true;
					const descLabel = new St.Label({
						text: shortcut.description, x_expand: true, y_expand: true,
						style: `${entryStyle}; padding-right:  ${paddingEntry}px;`
					});
					descLabel.clutter_text.line_wrap = true;
					if (this.firstLaunch) {
						keyLabel.connect('notify::allocation', () => {
							const allocation = keyLabel.get_allocation_box();
							const labelWidth = allocation.x2 - allocation.x1 - paddingEntry;
							const [, textWidth] = keyLabel.clutter_text.get_preferred_width(-1);
							if (textWidth >= labelWidth) {
								shortcutBox.set_height(2 * this.style.shortcut.entryHeight);
								this.indicesToUpdate.push(shortcutBox.index);
								shortcutBox.queue_relayout();
							}
						});
						descLabel.connect('notify::allocation', () => {
							const allocation = descLabel.get_allocation_box();
							const labelWidth = allocation.x2 - allocation.x1 - paddingEntry;
							const [, textWidth] = descLabel.clutter_text.get_preferred_width(-1);
							if (textWidth >= labelWidth) {
								shortcutBox.set_height(2 * this.style.shortcut.entryHeight);
								this.indicesToUpdate.push(shortcutBox.index);
								shortcutBox.queue_relayout();
							}
						});
					}
					shortcutBox.add_child(descLabel);
					shortcutBox.add_child(keyLabel);
					typeBox.add_child(shortcutBox);
				});
			});
			shortcutsBox.add_child(columnBox);
		});
		this.parentBox.queue_relayout();
	}


	updateShortcutsByRanks(cumulativeRanks) {
		let currentIndex = 0;
		const rankSet = new Set(cumulativeRanks);
		for (const category of this.processedJson) {
			const shortcuts = category.shortcuts;
			const categoryShortcutCount = shortcuts.length;
			for (let i = 0; i < categoryShortcutCount; i++) {
				if (rankSet.has(currentIndex + i)) {
					shortcuts[i].height = 2 * this.style.shortcut.entryHeight;
				}
			}
			currentIndex += categoryShortcutCount;
		}
	}
}
