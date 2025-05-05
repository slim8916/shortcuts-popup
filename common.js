const { GObject, Gio, GLib } = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();


const filesDir = GLib.build_filenamev([Me.path, '.files']);
var shortcutssFilePath = GLib.build_filenamev([filesDir, 'shortcuts.json']);

var RowModel = GObject.type_from_name("RowModel");
if (RowModel === null) {
	RowModel = GObject.registerClass(
		{
			Properties: {
				'app': GObject.ParamSpec.string('app', 'App', 'App Name', GObject.ParamFlags.READWRITE, ''),
				'type': GObject.ParamSpec.string('type', 'Type', 'Type of Shortcut', GObject.ParamFlags.READWRITE, ''),
				'shortcut': GObject.ParamSpec.string('shortcut', 'Shortcut', 'Keyboard Shortcut', GObject.ParamFlags.READWRITE, ''),
				'description': GObject.ParamSpec.string('description', 'Description', 'Shortcut Description', GObject.ParamFlags.READWRITE, ''),
			},
		},
		class RowModel extends GObject.Object { }
	);
}

var longestEntry = { app: '', type: '', shortcut: '', description: '' };

var Formatters = {
	formatShortcut: (text) => text.toLowerCase().replace(/([^a-zA-Z0-9\s])/g, " $1 ")
			.replace(/\b\w/g, (char) => char.toUpperCase()).replace(/\s+/g, ' ').trim(),
	formatText: (text) =>
		text.toLowerCase().replace(/([^a-zA-Z0-9\s])/g, ' $1 ').replace(/([\[({"])\s+/g, '$1')
			.replace(/\s+([)\]},.:;?¿!])/g, '$1').replace(/^./, (char) => char.toUpperCase()).replace(/\s+/g, ' ').trim()
};

function compareRows(a, b) {
	let cmp = a.app.localeCompare(b.app);
	if (cmp === 0) cmp = a.type.localeCompare(b.type);
	if (cmp === 0) cmp = a.shortcut.localeCompare(b.shortcut);
	return cmp;
}

function updateLongestEntry(nameApp, nameType, shortcut, description) {
	if (nameApp.length > longestEntry.app.length) longestEntry.app = nameApp;
	if (nameType.length > longestEntry.type.length) longestEntry.type = nameType;
	if (shortcut.length > longestEntry.shortcut.length) longestEntry.shortcut = shortcut;
	if (description.length > longestEntry.description.length) longestEntry.description = description;
}

function loadListStore(listStore, file = Gio.File.new_for_path(shortcutssFilePath)) {
	let jsonData=readShortcutsJson(file);
	if (typeof jsonData === 'string') return jsonData;

	let existingShortcuts = new Set();
	// To check for duplicates, we can use a Set to store existing shortcuts
	// for (let i = 0; i < listStore.get_n_items(); i++) existingShortcuts.add(Formatters.formatShortcut(listStore.get_item(i).shortcut));
	let skippedItems = [];

	const listItems = jsonData.flatMap(app => app.types.flatMap(type => type.shortcuts.map(shortcut => ({
		app: app.name,
		type: type.name,
		shortcut: shortcut.key,
		description: shortcut.description
	})
	)));

	listItems.forEach(item => {
		let NameApp = Formatters.formatText(item.app);
		let NameType = Formatters.formatText(item.type);
		let formattedShortcut = Formatters.formatShortcut(item.shortcut);
		let formattedDescription = Formatters.formatText(item.description);
		let skipReasons = [];
		if (!NameApp) skipReasons.push('Empty app name');
		if (!NameType) skipReasons.push('Empty type name');
		if (existingShortcuts.has(formattedShortcut)) skipReasons.push('Duplicate shortcut');
		let skipMsg = skipReasons.join(", ");
		if (skipMsg) {
			skippedItems.push(`${JSON.stringify(item).replace(/"(\w+)"\s*:/g, '$1: ').replace(/,(\S)/g, ", $1")} - Reason: ${skipMsg}.`);
		} else {
			let newItem = new RowModel({
				app: NameApp,
				type: NameType,
				shortcut: formattedShortcut,
				description: formattedDescription
			});
			listStore.append(newItem);
			updateLongestEntry(NameApp, NameType, formattedShortcut, formattedDescription);
			//existingShortcuts.add(formattedShortcut);
		}
	});
	listStore.sort(compareRows);
	return skippedItems;
}

function readShortcutsJson(file = Gio.File.new_for_path(shortcutssFilePath)) {
    if (!file.query_exists(null)) return "File does not exist";
    const [success, contents] = file.load_contents(null);
    if (!success) return "Failed to load file contents";
    const jsonString = new TextDecoder().decode(contents);
    let jsonData;
    try {
        jsonData = JSON.parse(jsonString);
    } catch (e) {
        return e.message;
    }
    if (!jsonData) return "JSON data is empty or null";
    const validationError = validateStructure(jsonData);
    if (validationError) return "JSON validation failed - " + validationError;
    return jsonData;
}

function validateStructure(data) {
	if (!Array.isArray(data)) return "Root element must be an array of applications";
	for (const [appIndex, app] of data.entries()) {
		if (typeof app?.name !== 'string')
			return `Application #${appIndex + 1} is missing valid 'name' string`;
		if (!Array.isArray(app?.types))
			return `Application '${app.name}' is missing 'types' array`;
		if (Object.keys(app).length !== 2)
			return `Application '${app.name}' contains unexpected properties (only 'name' and 'types' allowed)`;
		for (const [typeIndex, type] of app.types.entries()) {
			if (typeof type?.name !== 'string')
				return `Type #${typeIndex + 1} in '${app.name}' is missing valid 'name' string`;
			if (!Array.isArray(type?.shortcuts))
				return `Type '${type.name}' in '${app.name}' is missing 'shortcuts' array`;
			if (Object.keys(type).length !== 2)
				return `Type '${type.name}' in '${app.name}' contains unexpected properties (only 'name' and 'shortcuts' allowed)`;
			for (const [shortcutIndex, shortcut] of type.shortcuts.entries()) {
				if (typeof shortcut?.key !== 'string')
					return `Shortcut #${shortcutIndex + 1} in '${type.name}' is missing 'key' string`;
				if (typeof shortcut?.description !== 'string')
					return `Shortcut '${shortcut.key}' in '${type.name}' is missing 'description' string`;
				if (Object.keys(shortcut).length !== 2)
					return `Shortcut '${shortcut.key}' in '${type.name}' contains unexpected properties (only 'key' and 'description' allowed)`;
			}
		}
	}
	return null;
}