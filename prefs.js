import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw';

// Import common module
import * as Common from './common.js';




const padding = 5;

var PrefsWidget = GObject.registerClass(
	class PrefsWidget extends Gtk.Box {
		_init(settings, extension, window) {
			super._init({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 });
			this.settings = settings;
			this.extension = extension;
			this.window = window;
			this.builder = new Gtk.Builder();
			this.builder.add_from_file(this.extension.dir.get_path() + '/prefs.ui');
			const mainContainer = this.builder.get_object('main-container');
			this.append(mainContainer);
			const stack = this.builder.get_object('stack');
			const stackSwitcher = this.builder.get_object('stack_switcher');
			stackSwitcher.set_stack(stack);
			stack.add_titled(this.builder.get_object('data'), "data", "Load Data");
			stack.add_titled(this.builder.get_object('options'), "options", "Options");
			stack.set_visible_child_name("options");
			stack.set_visible_child_name("data");
			this.scrolledWindow = this.builder.get_object('scrolled-window');
			this.connect('realize', () => {
				const display = Gdk.Display.get_default();
				const monitor = display.get_monitor_at_surface(this.window.get_surface());
				const geometry = monitor.get_geometry();
				this.columnView.totalWidth = Math.ceil(geometry.width * 0.7);
				this.scrolledWindow.set_size_request(this.columnView.totalWidth, -1);
				this.window.set_default_size(-1, Math.ceil(geometry.height * .7));
				this._computeWidthColumn(this.columnView);
			})
			const isIconHidden = this.builder.get_object('hide_icon');
			const numberCols = this.builder.get_object('number_cols');
			const fontSize = this.builder.get_object('font_size');
			isIconHidden.set_active(this.settings.get_boolean("hide-icon"));
			numberCols.set_value(this.settings.get_int("number-cols"));
			fontSize.set_value(this.settings.get_int("font-size"));
			isIconHidden.connect("toggled", () => this.settings.set_boolean("hide-icon", isIconHidden.get_active()));
			numberCols.connect("value-changed", () => this.settings.set_int("number-cols", numberCols.get_value_as_int()));
			fontSize.connect("value-changed", () => this.settings.set_int("font-size", fontSize.get_value_as_int()));
			this._setupColumnView();
		}

		_computeWidthColumn(columnView) {
			const minWidthEntry = {rank: 0, app: 0, type: 0, shortcut: 0, description: 0 };
			Common.longestEntry.rank = columnView.get_columns().get_n_items().toString();
			const paddingEntry = 9 * padding;
			const label = new Gtk.Label();
			for (const key in minWidthEntry) {
				label.set_text(Common.longestEntry[key]);
				const layout = label.get_layout();
				const [width,] = layout.get_pixel_size();
				minWidthEntry[key] = width + paddingEntry;
			}
			let totalWidth = columnView.totalWidth;
			const initialTotalWidth = totalWidth;
			const widthColumns = {};

			widthColumns.rank = Math.ceil(minWidthEntry.rank > paddingEntry ? minWidthEntry.rank : totalWidth / 4);
			totalWidth -= widthColumns.rank;
			widthColumns.shortcut = Math.ceil(minWidthEntry.shortcut > paddingEntry ? minWidthEntry.shortcut : totalWidth / 4);
			totalWidth -= widthColumns.shortcut;
			widthColumns.app = Math.ceil(minWidthEntry.app > paddingEntry ? minWidthEntry.app * (totalWidth > 0 ? 1 : 0.8) : (totalWidth > 0 ? totalWidth / 4 : initialTotalWidth / 8));
			totalWidth -= widthColumns.app;
			widthColumns.type = Math.ceil(minWidthEntry.type > paddingEntry ? minWidthEntry.type * (totalWidth > 0 ? 1 : 0.7) : (totalWidth > 0 ? totalWidth / 4 : initialTotalWidth / 8));
			totalWidth -= widthColumns.type;
			widthColumns.description = Math.ceil(totalWidth > paddingEntry ? Math.max(minWidthEntry.description, totalWidth) :
				(minWidthEntry.description > 0 ? minWidthEntry.description * 0.5 : initialTotalWidth / 8));

			const columns = columnView.get_columns();
			for (let i = 0; i < columns.get_n_items(); i++) {
				const column = columns.get_item(i);
				column.set_fixed_width(widthColumns[column.propertyName]);
			}
		}

		_writeShortcutsJson(listStore) {
			const existingShortcuts = new Set();
			Common.longestEntry = { app: '', type: '', shortcut: '', description: '' };
			const _listStore = new Gio.ListStore({ item_type: Common.RowModel });
			const skippedItems = [];
			for (let i = 0; i < listStore.get_n_items(); i++) {
				const row = listStore.get_item(i);
				const NameApp = Common.Formatters.formatText(row.app);
				const NameType = Common.Formatters.formatText(row.type);
				const formattedShortcut = Common.Formatters.formatShortcut(row.shortcut);
				const formattedDescription = Common.Formatters.formatText(row.description);
				const skipReasons = [];
				if (!NameApp) skipReasons.push('Empty app name');
				if (!NameType) skipReasons.push('Empty type name');
				if (existingShortcuts.has(formattedShortcut)) skipReasons.push('Duplicate shortcut');
				const skipMsg = skipReasons.join(", ");
				if (skipMsg) {
					skippedItems.push(`{app: "${row.app}", type: "${row.type}", shortcut: "${row.shortcut}", description: "${row.description}"} - Reason: ${skipMsg}.`);
				} else {
					const newItem = new Common.RowModel({
						app: NameApp,
						type: NameType,
						shortcut: formattedShortcut,
						description: formattedDescription
					});
					_listStore.append(newItem);
					Common.updateLongestEntry(NameApp, NameType, formattedShortcut, formattedDescription);
					//To check for duplicates, we can use a Set to store existing shortcuts
					//existingShortcuts.add(formattedShortcut);
				}
			}
			_listStore.sort(Common.compareRows);
			listStore = _listStore;
			try {
				const appsMap = new Map();
				for (let i = 0; i < listStore.get_n_items(); i++) {
					const rowModel = listStore.get_item(i);
					if (!appsMap.has(rowModel.app)) appsMap.set(rowModel.app, new Map());
					const typesMap = appsMap.get(rowModel.app);
					if (!typesMap.has(rowModel.type)) typesMap.set(rowModel.type, []);
					typesMap.get(rowModel.type).push({ key: rowModel.shortcut, description: rowModel.description });
				}
				const jsonData = [];
				const sortedApps = Array.from(appsMap.keys()).sort();
				sortedApps.forEach(app => {
					const typesMap = appsMap.get(app);
					const types = [];
					const sortedTypes = Array.from(typesMap.keys()).sort();
					sortedTypes.forEach(type => types.push({ name: type, shortcuts: typesMap.get(type) }));
					jsonData.push({ name: app, types: types });
				});
				const jsonString = JSON.stringify(jsonData, null, 2);
				const file = Gio.File.new_for_path(Common.shortcutssFilePath);
				const outputStream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
				const data = new TextEncoder().encode(jsonString);
				outputStream.write_all(data, null);
				outputStream.close(null);
				log(`Successfully wrote ${listStore.get_n_items()} items to ${Common.shortcutssFilePath}.`);
			} catch (error) {
				logError(error, `Error writing to JSON file: ${Common.shortcutssFilePath}`);
			}
			return skippedItems;
		}

		_showSkippedItemsDialog(skippedItems, mainWindow) {
			if (skippedItems.length === 0) return;
			const messageText = `${skippedItems.length} item were not added:\n\n ${skippedItems.map((str, rk) => `${rk + 1}. ${str}`).join("\n\n")}`;
			const dialog = new Gtk.Dialog({ transient_for: mainWindow, modal: true, title: "Skipped Items" });
			dialog.add_button("_Close", Gtk.ResponseType.CLOSE);
			const textView = new Gtk.TextView({ hexpand: true, vexpand: true, margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12 });
			textView.get_buffer().set_text(messageText, -1);
			const scrolledWindow = new Gtk.ScrolledWindow({ min_content_height: 200, min_content_width: 800 });
			scrolledWindow.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
			scrolledWindow.set_child(textView);
			dialog.get_content_area().append(scrolledWindow);
			dialog.connect("response", (dialog, _) => {
				dialog.destroy();
				mainWindow.present();
			});
			dialog.show();
		}

		_countShortcutOccurrences(listStore, shortcut) {
			let count = 0;
			for (let i = 0, len = listStore.get_n_items(); i < len; i++) {
				if (listStore.get_item(i).shortcut === shortcut) {
					if (count > 0) return 2;
					count++;
				}
			}
			return count;
		}

		async _setupColumnView() {
			this.columnView = this.builder.get_object('items-treeview');
			this.columnView.set_reorderable(false);
			const listStore = new Gio.ListStore({ item_type: Common.RowModel });
			await Common.loadListStore(listStore);
			const filterListModel = new Gtk.FilterListModel({ model: listStore });
			const filter = new Gtk.CustomFilter();
			const filterCondition = { app: '', type: '', shortcut: '' };
			filter.set_filter_func((_) => true);
			filterListModel.set_filter(filter);
			const sortModel = new Gtk.SortListModel({ model: filterListModel, sorter: null });
			const selectionModel = new Gtk.MultiSelection({ model: sortModel });
			this.columnView.set_model(selectionModel);
			const _updateFilter = () => {
				filter.set_filter_func((row) => {
					const appMatches = row['app'].toLowerCase().includes(filterCondition.app);
					const typeMatches = row['type'].toLowerCase().includes(filterCondition.type);
					const shortcutMatches = row['shortcut'].toLowerCase().includes(filterCondition.shortcut);
					return appMatches && typeMatches && shortcutMatches;
				});
				filter.changed(Gtk.FilterChange.DIFFERENT);
			}
			const _createColumn = (title, propertyName, isRankingCol =false) => {
				const column = new Gtk.ColumnViewColumn({
					title: title,
					expand: false,
					resizable: true,
				});
				column.propertyName = propertyName;
				column.sortAscending = null;
				const factory = new Gtk.SignalListItemFactory();
				const cssProvider = new Gtk.CssProvider();
				const cssData = ` entry { padding: ${padding}px; } `;
				cssProvider.load_from_data(cssData, cssData.length);			
				factory.connect('setup', (_, listItem) => {
					const entry = new Gtk.Entry({ hexpand: true, placeholder_text: `Enter ${propertyName}...`, editable: !isRankingCol});
					entry.get_style_context().add_provider(cssProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
					entry.isWarned=false;
					listItem.set_child(entry);
				});
				factory.connect('bind', (_, listItem) => {
					const entry = listItem.get_child();
					const position = listItem.get_position();
					if (isRankingCol) {
						entry.set_text((position + 1).toString());
					} else {
						const row = listItem.get_item();
						entry.set_text(row[propertyName] || '');
						entry.connect('changed', () => {
							setTimeout(() => {
								const currentText = entry.get_text();
								if (currentText !== row[propertyName]) {
									const formatFunction = propertyName === 'app' || propertyName === 'type' ? Common.Formatters.formatText
														: propertyName === 'shortcut' ? Common.Formatters.formatShortcut : Common.Formatters.formatText;
									const formattedText = formatFunction(currentText);
									entry.set_text(formattedText);
									entry.set_position(formattedText.length);
									if (propertyName === 'shortcut') {
										const isDuplicate = formattedText && this._countShortcutOccurrences(listStore, formattedText) > 0;
										const parent = entry.get_parent()?.get_parent();
										if (isDuplicate) parent?.get_style_context()?.add_class("duplicate-entry");
										else parent?.get_style_context()?.remove_class("duplicate-entry");
										parent?.set_tooltip_text(isDuplicate ? 'This shortcut key combination has already been used!' : null);
										entry.isWarned = isDuplicate;
										entry.queue_draw();
									}
									row[propertyName] = formattedText;
								}else if(entry.isWarned && propertyName === 'shortcut' && this._countShortcutOccurrences(listStore, currentText) ===1) {
									entry.get_parent()?.get_parent()?.get_style_context()?.remove_class("duplicate-entry");
									entry.get_parent()?.get_parent()?.set_tooltip_text(null);
									entry.isWarned=false;
									entry.queue_draw();
								}
							}, 800);
						});
					}
					const focusController = new Gtk.EventControllerFocus();
					entry.add_controller(focusController);
					focusController.connect('enter', () => {
						const position = listItem.get_position();
						if (position !== -1) selectionModel.select_item(position, true);
					});
				});
				column.set_factory(factory);
				if (!isRankingCol) {
					const sorter = new Gtk.CustomSorter();
					sorter.set_sort_func((a, b) => {
						const aValue = a[propertyName]?.toLowerCase() || '';
						const bValue = b[propertyName]?.toLowerCase() || '';
						return aValue.localeCompare(bValue) * (column.sortAscending ? -1 : 1);
					});
					column.set_sorter(sorter);
				}
				return column;
			}
			this.columnView.append_column(_createColumn('#', 'rank', true));
			this.columnView.append_column(_createColumn('App', 'app'));
			this.columnView.append_column(_createColumn('Type', 'type'));
			this.columnView.append_column(_createColumn('Shortcut', 'shortcut'));
			this.columnView.append_column(_createColumn('Description', 'description'));
			this.columnView.queue_draw();
			const gesture = new Gtk.GestureClick();
			gesture.set_button(1);
			gesture.connect('pressed', (_, _n_press, x, y) => {
				if (y > 30) return;
				const columns = this.columnView.get_columns();
				if (x<columns.get_item(0).get_fixed_width()) return;
				const nItems = columns.get_n_items();
				let i = 1;
				let cumulativeWidth= columns.get_item(0).get_fixed_width() + columns.get_item(1).get_fixed_width();
				while (i < nItems && cumulativeWidth < x) {
					i++;
					cumulativeWidth+= columns.get_item(i).get_fixed_width();
				}
				const clickedColumn = columns.get_item(i);
				sortModel.set_sorter(clickedColumn.get_sorter());
				clickedColumn.sortAscending = !clickedColumn.sortAscending;
			});
			this.columnView.add_controller(gesture);
			const searchApp = this.builder.get_object('search_app');
			searchApp.connect('changed', () => {
				filterCondition.app = searchApp.text.trim();
				_updateFilter();
			});
			const searchType = this.builder.get_object('search_type');
			searchType.connect('changed', () => {
				filterCondition.type = searchType.text.trim();
				_updateFilter();
			});
			const searchShortcut = this.builder.get_object('search_shortcut');
			searchShortcut.connect('changed', () => {
				filterCondition.shortcut = searchShortcut.text.trim();
				_updateFilter();
			});
			function getSelectedIndices() {
				const selection = [];
				const selectedItems = selectionModel.get_selection();
				for (let i = 0; i < selectedItems.get_size(); i++) selection.push(selectedItems.get_nth(i));
				return selection;
			}			
			const addButton = this.builder.get_object('add_button');
			const saveButton = this.builder.get_object('save_button');
			const deleteButton = this.builder.get_object('delete_button');
			addButton.connect('clicked', () => {
				const selectedIndices = getSelectedIndices();
				const nItems = listStore.get_n_items();
				const insertionIndex = (selectedIndices.length === 0) ? nItems : (Math.max(...selectedIndices) + 1);
				listStore.insert(insertionIndex, new Common.RowModel({ app: "", type: "", shortcut: "", description: "" }));
				const adjustment = this.scrolledWindow.get_vadjustment();
				const rowHeight = adjustment.get_upper() / (nItems + 1);
				const targetPosition = insertionIndex * rowHeight - adjustment.get_page_size() / 2;
				adjustment.set_value(Math.min(targetPosition, adjustment.get_upper() - adjustment.get_page_size()));
				selectionModel.select_item(insertionIndex, true);
			});
			saveButton.connect('clicked', () => {
				const resWrite=this._writeShortcutsJson(listStore);
				this._showSkippedItemsDialog(resWrite, this.window);
				this._computeWidthColumn(this.columnView);
			});
			deleteButton.connect('clicked', () => {
				const selectedIndices = getSelectedIndices().sort((a, b) => a - b);
				const uniqueIndices = [...new Set(selectedIndices)];
				listStore.freeze_notify();
				const newList = [];
				for (let i = 0; i < listStore.get_n_items(); i++) {
					if (!uniqueIndices.includes(i)) {
						newList.push(listStore.get_item(i));
					}
				}
				listStore.splice(0, listStore.get_n_items(), newList);			
				listStore.thaw_notify();
			});
			const loadData = this.builder.get_object('data_load_button');
			loadData.connect('clicked', () => {
				const fileChooser = new Gtk.FileChooserDialog({
					title: "Read Json File",
					action: Gtk.FileChooserAction.OPEN,
					modal: true,
					transient_for: this.window
				});
				fileChooser.add_button("_Cancel", Gtk.ResponseType.CANCEL);
				fileChooser.add_button("_Open", Gtk.ResponseType.ACCEPT);
				const jsonFilter = new Gtk.FileFilter();
				jsonFilter.add_mime_type("application/json");
				jsonFilter.add_pattern("*.json");
				fileChooser.set_filter(jsonFilter);
				fileChooser.connect("response", async (_, responseId) => {
					if (responseId === Gtk.ResponseType.ACCEPT) {
						const result = await Common.loadListStore(listStore, fileChooser.get_file());
						if (typeof result === "string") {
							const warningDialog = new Gtk.MessageDialog({
								transient_for: fileChooser,
								modal: true,
								use_markup: true,
								buttons: Gtk.ButtonsType.OK,
								message_type: Gtk.MessageType.WARNING,
								text: "Invalid file selected!",
								secondary_text: `\nError: ${result}.\n\nPlease ensure that your JSON matches the structure specified in the README file located in the extension directory.`
							});
							warningDialog.connect("response", () => {
								warningDialog.destroy();
								fileChooser.present();
							});
							warningDialog.show();
						} else {
							fileChooser.close();
							fileChooser.destroy();
							this._computeWidthColumn(this.columnView);
							if (Array.isArray(result)) this._showSkippedItemsDialog(result, this.window);
						}
					} else if (responseId === Gtk.ResponseType.CANCEL) {
						fileChooser.close();
						fileChooser.destroy();
					}
				});
				fileChooser.show();
			});
			this.columnView.set_show_column_separators(true);
		}
	});

// Modern GNOME Shell extension preferences using class-based approach
export default class ShortcutsPopupPreferences extends ExtensionPreferences {
	fillPreferencesWindow(window) {
		// Initialize common module with extension info
		Common.initCommon(this);

		// Cleanup on window close
		window.connect('close-request', () => {
			Common.uninit();
		});

		// Get settings
		const settings = this.getSettings();

		// Load CSS styles
		const styleProvider = new Gtk.CssProvider();
		styleProvider.load_from_path(this.dir.get_path() + '/style.css');
		Gtk.StyleContext.add_provider_for_display(
			Gdk.Display.get_default(),
			styleProvider,
			Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
		);

		// Create preferences widget
		const prefsWidget = new PrefsWidget(settings, this, window);

		// Create an AdwPreferencesPage and add our custom widget
		const page = new Adw.PreferencesPage();
		const group = new Adw.PreferencesGroup();
		group.add(prefsWidget);
		page.add(group);

		// Add page to window
		window.add(page);
	}
}