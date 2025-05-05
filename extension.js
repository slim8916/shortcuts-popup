const { Gio, Clutter, GLib, GObject, Shell, St, Pango, Gdk, PangoCairo, GdkPixbuf, Meta, } = imports.gi;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Common = Me.imports.common;

const filesDir = GLib.build_filenamev([Me.path, '.files']);
const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.shortcuts-popup';
const schemaDir = Me.dir.get_child('schemas');
const settings = new Gio.Settings({
	settings_schema: Gio.SettingsSchemaSource.new_from_directory(
		schemaDir.get_path(),
		Gio.SettingsSchemaSource.get_default(),
		false).lookup(SETTINGS_SCHEMA, true)
});




let statusIcon = null;
const StatusIcon = GObject.registerClass(
	class StatusIcon extends PanelMenu.Button {
		_init() {
			super._init(0.0, 'Status Icon');
			if (!isIconHidden) {
				let icon = new St.Icon({ gicon: Gio.icon_new_for_string(GLib.build_filenamev([filesDir, 'icon.png'])) });
				this.add_child(icon);
			}
			this.connect('button-press-event', () => openLayoutShortcuts());
		}
	}
);

let fullscreenOverlay = null;
const FullscreenWidget = GObject.registerClass(
	class FullscreenWidget extends St.Widget {
		_init() {
			super._init({
				style_class: 'fullscreen-overlay',
				reactive: true,
				can_focus: true,
				track_hover: true,
				layout_manager: new Clutter.BinLayout(),
			});
			this.set_style('background-color: rgba(0,0,0,0.8); pointer-events: all; z-index: 99999;');
			let monitor = Main.layoutManager.monitors[0];
			this.set_size(monitor.width, monitor.height);
			this.set_position(monitor.x, monitor.y);
			this.scrollView = new St.ScrollView({
				hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.NEVER,
				x_expand: true, y_expand: true
			});
			if (parentBox === null) {
				parentBox = new St.BoxLayout({ vertical: true, x_expand: true, });
				resetlayout();
			} else if (!firstLaunch && !parentBox.isError) {
				try {
					parentBox.resetSearchEntry();
				} catch (e) {
					log(e.message);
				}
			}
			this.scrollView.add_actor(parentBox);
			this.add_child(this.scrollView);
			if (firstLaunch) buildLayout(monitor.width);
			this.connect('button-press-event', () => {
				this.scrollView.remove_actor(parentBox);
				fullscreenOverlay.destroy();
				fullscreenOverlay = null;
				return Clutter.EVENT_STOP;
			});
			this.connect("key-press-event", (_, event) => {
				if (event.get_key_symbol() === Clutter.KEY_Escape) {
					this.scrollView.remove_actor(parentBox);
					fullscreenOverlay.destroy();
					fullscreenOverlay = null;
					return Clutter.EVENT_STOP;
				}
				return Clutter.EVENT_PROPAGATE;
			});
			this.grab_key_focus();
			if (firstLaunch) {
				this.connect('notify::allocation', () => {
					updateShortcutsByRanks(indicesToUpdate);
					let columns = createColumns();
					createComponents(columns);
					firstLaunch = false;
					freeMemory();
				});
			}
		}
	}
);



function openLayoutShortcuts() {
	if (!fullscreenOverlay) {
		fullscreenOverlay = new FullscreenWidget();
		Main.uiGroup.add_child(fullscreenOverlay);
		Main.pushModal(fullscreenOverlay);
		fullscreenOverlay.grab_key_focus();
	}
}


const indicesToUpdate = [];
let firstLaunch;
let parentBox;
let numberCols;
let isIconHidden;
let fileMonitor;

let colors;
let resultReadJsonFile;
let processedJson;


let style;

function init() {
	isIconHidden = settings.get_boolean('hide-icon');
	numberCols = settings.get_int('number-cols');
	let shortcutsJsonFile = Gio.File.new_for_path(GLib.build_filenamev([filesDir, 'shortcuts.json']));
	try {
		fileMonitor = shortcutsJsonFile.monitor(Gio.FileMonitorFlags.NONE, null);
		fileMonitor.connect("changed", (_monitor, _file, _otherFile, eventType) => {
			switch (eventType) {
				case Gio.FileMonitorEvent.CREATED:
				case Gio.FileMonitorEvent.CHANGED:
				case Gio.FileMonitorEvent.DELETED:
					resetlayout();
					break;
			}
		});
	} catch (error) {
		log("Error monitoring file: " + error.message);
	}
	parentBox = new St.BoxLayout({ vertical: true, x_expand: true, });
	resetlayout();
}
function resetlayout() {
	firstLaunch = true;
	resultReadJsonFile = Common.readShortcutsJson();
	colors = generateDarkSpectrumColorsHex(resultReadJsonFile.length);

}
function freeMemory() {
	resultReadJsonFile = null;
	processedJson = null;
	colors = null;
	style = null;
}
function buildLayout(totalWidth) {
	if (typeof resultReadJsonFile === 'string') {
		parentBox.remove_all_children();
		let label = new St.Label({
			text: `\nError: ${resultReadJsonFile}.\n\nPlease ensure that your JSON matches the structure specified in the README file located in the extension directory.`,
			style: 'font-size: 28px; color: white; margin: 20px; text-align: center;', x_expand: true,
			y_align: Clutter.ActorAlign.CENTER,
		});
		parentBox.add_child(label);
		parentBox.queue_relayout();
		parentBox.isError = true;
		freeMemory();
	} else {
		loadStyle(totalWidth);
		processJsonFile();
		let columns = createColumns();
		createComponents(columns);
	}
}

function processJsonFile() {
	processedJson = resultReadJsonFile.flatMap(app =>
		app.types.flatMap(type => ({
			appName: app.name,
			typeName: type.name,
			shortcuts: type.shortcuts.map(shortcut => {
				return {
					key: shortcut.key,
					description: shortcut.description,
					height: style.shortcut.entryHeight
				};
			})
		}))
	);
}
function createColumns() {
	function computeTotalHeight(jsonArr) {
		let totalHeight = 0;
		jsonArr.forEach(entry => entry.shortcuts.forEach(shortcut => totalHeight += shortcut.height));
		totalHeight += jsonArr.length * style.shortcut.typeHeight;
		return totalHeight;
	}
	let targetHeight = 0;
	let remainingShortcuts = processedJson.slice();
	let columns = [];
	let iter = 0;
	while (remainingShortcuts.length > 0 && iter < 10) {
		targetHeight = targetHeight + (computeTotalHeight(remainingShortcuts) / numberCols);
		remainingShortcuts = processedJson.slice();
		columns = [];
		for (let i = 0; i < numberCols; i++) {
			let currentHeight = 0;
			let column = [];
			while (currentHeight < targetHeight && remainingShortcuts.length > 0) {
				let entry = remainingShortcuts[0];
				const entryToCopy = { appName: entry.appName, typeName: entry.typeName, shortcuts: [] };
				const entryToKeep = { appName: entry.appName, typeName: entry.typeName + ' (Continued)', shortcuts: [] };
				for (let j = 0; j < entry.shortcuts.length; j++) {
					const shortcut = entry.shortcuts[j];
					if (currentHeight < targetHeight) {
						entryToCopy.shortcuts.push(shortcut);
						currentHeight += shortcut.height;
						if (j == 0) currentHeight += style.shortcut.typeHeight + 2 * style.shortcut.typeMargin;
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
function loadStyle(totalWidth) {
	const adjustHeaderFontSize = 6;
	style = { column: { margin: 8, }, shortcut: { typePadding: 16, typeMargin: 24 } };
	style.column.width = Math.round(totalWidth / numberCols) - 2 * style.column.margin;
	style.shortcut.entryFontSize = settings.get_int('font-size');
	style.shortcut.typeFontSize = style.shortcut.entryFontSize + adjustHeaderFontSize;
	style.shortcut.entryHeight = computeLabelHeight('Sample Text', style.shortcut.entryFontSize);
	style.shortcut.typeHeight = computeLabelHeight('Sample Text', style.shortcut.typeFontSize);
	style.shortcut.keyLabelWidth = Math.ceil((style.column.width - 2 * style.shortcut.typePadding) * 0.35);
	function computeLabelHeight(text, fontSize) {
		let label = new St.Label({ text: text });
		let layout = Pango.Layout.new(label.clutter_text.get_pango_context());
		layout.set_text(text, -1);
		let fd = Pango.FontDescription.from_string("Sans Bold");
		fd.set_size(fontSize * Pango.SCALE);
		layout.set_font_description(fd);
		return Math.round(0.57 * layout.get_pixel_size()[1]);
	}
}
function generateDarkSpectrumColorsHex(n) {
	function hslToHex(h, s, l) {
		s /= 100;
		l /= 100;
		let c = (1 - Math.abs(2 * l - 1)) * s;
		let x = c * (1 - Math.abs((h / 60) % 2 - 1));
		let m = l - c / 2;
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
	}
	let colors = [];
	let startHue = 0;
	let endHue = 275;
	let lightness = 18;
	let saturation = 90;
	for (let i = 0; i < n; i++) {
		let hue = startHue + (i / (n - 1)) * (endHue - startHue);
		colors.push(hslToHex(hue, saturation, lightness));
	}
	return colors;
}




function createComponents(columns) {
	parentBox.remove_all_children();
	parentBox.isError = false;
	let rowSearch = new St.BoxLayout({ vertical: false, x_expand: false, x_align: Clutter.ActorAlign.CENTER, style: `padding: 8px;`, });
	let searchEntry = new St.Entry({
		x_expand: false, hint_text: "Search for...", can_focus: true,
		style: `background-color: black; padding: 16px; font-weight: bold; font-size: 20px; width: 400px;`
	});
	rowSearch.add_child(searchEntry);
	parentBox.resetSearchEntry = function () {
		searchEntry.set_text('');
		GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
			searchEntry.grab_key_focus();
			return GLib.SOURCE_REMOVE;
		});
	};
	parentBox.resetSearchEntry();
	searchEntry.connect("key-press-event", (_actor, event) => {
		let keyval = event.get_key_symbol();
		let keyString = getKeyString(keyval);
	
		if (keyString) {
			let oldText = searchEntry.get_text();
			if (!oldText.includes(keyString)) {
				searchEntry.set_text(oldText + (oldText ? " " : "") + keyString);
			}
		}
	});
	function getKeyString(keyval) {
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
	}
	searchEntry.clutter_text.connect("text-changed", () => {
		let searchTerms = searchEntry.get_text().trim().replace(/\s+/g, ' ').toLowerCase().split(/\s+/);		
		shortcutsBox.get_children().forEach(columnBox => {
			columnBox.get_children().forEach(actor => {
				if (!(actor instanceof St.BoxLayout) || !actor.vertical) return;
				let typeBox = actor;
				let typeLabelBox = typeBox.get_previous_sibling();
				let typeLabel = typeLabelBox ? typeLabelBox.get_children()[0] : null;
				let typeText = typeLabel ? typeLabel.get_text().toLowerCase() : "";
	
				let typeNameMatches = searchTerms.every(term => typeText.includes(term));
				let hasVisibleShortcut = false;
	
				typeBox.get_children().forEach(shortcutBox => {
					let children = shortcutBox.get_children();
					let descText = children[0].get_text().toLowerCase();
					let keyText = children[1].get_text().toLowerCase();
					let descMatches = searchTerms.every(term => descText.includes(term));
					let keyMatches = searchTerms.every(term => keyText.includes(term));
					let shouldShowShortcut = typeNameMatches || keyMatches || descMatches;
					shortcutBox.visible = shouldShowShortcut;
					if (shouldShowShortcut)	hasVisibleShortcut = true;
				});
	
				typeBox.visible = hasVisibleShortcut || typeNameMatches;
				if (typeLabelBox) typeLabelBox.visible = typeBox.visible;
			});
		});
	});
	






	parentBox.add(rowSearch);
	shortcutsBox = new St.BoxLayout({ vertical: false, x_expand: true, });
	parentBox.add(shortcutsBox);
	let typeStyle = `font-weight: bold; font-size: ${style.shortcut.typeFontSize}px; margin-top: ${style.shortcut.typeMargin}px; margin-bottom: ${style.shortcut.typeMargin}px;`;
	let entryStyle = `font-weight: bold; font-size: ${style.shortcut.entryFontSize}px`;
	let index = 0;
	let paddingEntry = 6;
	let currentApp = null;
	let appIndex = -1;
	columns.forEach(column => {
		let columnBox = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true, style: `margin: ${style.column.margin}px; width: ${style.column.width}px;` });
		column.forEach(typeGroup => {
			if (typeGroup.shortcuts.length === 0) return;
			if (currentApp !== typeGroup.appName) {
				currentApp = typeGroup.appName;
				appIndex++;
			}
			let typeLabelBox = new St.Widget({ layout_manager: new Clutter.BinLayout(), x_expand: true, });
			let typeLabel = new St.Label({ text: typeGroup.typeName, style: typeStyle });
			typeLabelBox.add_actor(typeLabel);
			columnBox.add_child(typeLabelBox);
			let typeBox = new St.BoxLayout({
				vertical: true, x_expand: true, y_expand: true,
				style: `background-color: ${colors[appIndex]}; padding: ${style.shortcut.typePadding}px`
			});
			columnBox.add_child(typeBox);
			typeGroup.shortcuts.forEach(shortcut => {
				let shortcutBox = new St.BoxLayout({ vertical: false, x_expand: true, style: `height: ${shortcut.height}px; padding-top: 8px;` });
				let keyLabel = new St.Label({
					text: shortcut.key, y_expand: true,
					style: `${entryStyle}; width: ${style.shortcut.keyLabelWidth}px; padding-left: ${paddingEntry}px;`
				});
				shortcutBox.index = index;
				index += 1;
				keyLabel.clutter_text.line_wrap = true;
				let descLabel = new St.Label({
					text: shortcut.description, x_expand: true, y_expand: true,
					style: `${entryStyle}; padding-right:  ${paddingEntry}px;`
				});
				descLabel.clutter_text.line_wrap = true;
				if (firstLaunch) {
					keyLabel.connect('notify::allocation', () => {
						let allocation = keyLabel.get_allocation_box();
						let labelWidth = allocation.x2 - allocation.x1 - paddingEntry;
						let [, textWidth] = keyLabel.clutter_text.get_preferred_width(-1);
						if (textWidth >= labelWidth) {
							shortcutBox.set_height(2 * style.shortcut.entryHeight);
							indicesToUpdate.push(shortcutBox.index);
							shortcutBox.queue_relayout();
						}
					});
					descLabel.connect('notify::allocation', () => {
						let allocation = descLabel.get_allocation_box();
						let labelWidth = allocation.x2 - allocation.x1 - paddingEntry;
						let [, textWidth] = descLabel.clutter_text.get_preferred_width(-1);
						if (textWidth >= labelWidth) {
							shortcutBox.set_height(2 * style.shortcut.entryHeight);
							indicesToUpdate.push(shortcutBox.index);
							shortcutBox.queue_relayout();
						}
					});
				}
				shortcutBox.add_child(descLabel);
				shortcutBox.add_child(keyLabel);
				typeBox.add_child(shortcutBox);
			});
		});
		shortcutsBox.add(columnBox);
	});
	parentBox.queue_relayout();
}


function updateShortcutsByRanks(cumulativeRanks) {
	let currentIndex = 0;
	const rankSet = new Set(cumulativeRanks);
	for (const category of processedJson) {
		const shortcuts = category.shortcuts;
		const categoryShortcutCount = shortcuts.length;
		for (let i = 0; i < categoryShortcutCount; i++) {
			if (rankSet.has(currentIndex + i)) {
				shortcuts[i].height = 2 * style.shortcut.entryHeight;
			}
		}
		currentIndex += categoryShortcutCount;
	}
}



function enable() {
	settings.connect('changed::hide-icon', () => {
		isIconHidden = settings.get_boolean('hide-icon');
		resetlayout();
	});
	settings.connect('changed::number-cols', () => {
		numberCols = settings.get_int('number-cols');
		resetlayout();
	});
	settings.connect('changed::font-size', () => {
		style.shortcut.entryFontSize = settings.get_int('font-size');
		resetlayout();
	});
	firstLaunch = true;
	statusIcon = new StatusIcon();
	Main.panel.addToStatusArea('status-icon', statusIcon);
	Main.wm.addKeybinding(
		'shortcuts-toggle-overview',
		settings,
		Meta.KeyBindingFlags.NONE,
		Shell.ActionMode.ALL,
		openLayoutShortcuts
	);
}
function disable() {
	Main.wm.removeKeybinding('shortcuts-toggle-overview');
	if (parentBox) {
		parentBox.destroy();
		parentBox = null;
	}
	if (statusIcon) {
		statusIcon.destroy();
		statusIcon = null;
	}
	if (fullscreenOverlay) {
		Main.popModal(fullscreenOverlay);
		fullscreenOverlay.destroy();
		fullscreenOverlay = null;
	}
}


const filePath = 'logs.txt';
let file = Gio.File.new_for_path(filePath);
function appendToFile(text) {
	text = JSON.stringify(text, null, 2);
	let outputStream = file.append_to(Gio.FileCreateFlags.NONE, null);
	outputStream.write(text + "\n", null);
	outputStream.close(null);
}
