import { HTMLBox } from "@bokehjs/models/layouts/html_box";
import { div } from "@bokehjs/core/dom";
import { Enum } from "@bokehjs/core/kinds";
import { ColumnDataSource } from "@bokehjs/models/sources/column_data_source";
import { TableColumn } from "@bokehjs/models/widgets/tables";
import { transform_cds_to_records } from "./data";
import { PanelHTMLBoxView, set_size } from "./layout";
// The view of the Bokeh extension/ HTML element
// Here you can define how to render the model as well as react to model changes or View events.
export class DataTabulatorView extends PanelHTMLBoxView {
    constructor() {
        super(...arguments);
        this._tabulator_cell_updating = false;
        this._selection_updating = false;
        this._styled_cells = [];
    }
    connect_signals() {
        super.connect_signals();
        const resize = () => {
            this.render();
            this.update_layout();
            if (this.root == this) {
                this.compute_viewport();
                this.compute_layout();
            }
            else {
                this.compute_layout();
                this.root.resize_layout();
            }
        };
        const { configuration, layout, columns, theme, theme_url, groupby } = this.model.properties;
        this.on_change([configuration, layout, columns, groupby], () => resize());
        this.on_change([theme, theme_url], () => this.setCSS());
        this.connect(this.model.properties.download.change, () => {
            const ftype = this.model.filename.endsWith('.json') ? "json" : "csv";
            this.tabulator.download(ftype, this.model.filename);
        });
        this.connect(this.model.properties.hidden_columns.change, () => {
            this.hideColumns();
        });
        this.connect(this.model.properties.page_size.change, () => {
            this.setPageSize();
        });
        this.connect(this.model.properties.page.change, () => {
            this.setPage();
        });
        this.connect(this.model.properties.max_page.change, () => {
            this.setMaxPage();
        });
        this.connect(this.model.properties.frozen_rows.change, () => {
            this.freezeRows();
        });
        this.connect(this.model.properties.styles.change, () => {
            this.updateStyles();
        });
        this.connect(this.model.source.properties.data.change, () => {
            this.setData();
        });
        this.connect(this.model.source.streaming, () => this.addData());
        this.connect(this.model.source.patching, () => this.updateOrAddData());
        this.connect(this.model.source.selected.change, () => this.updateSelection());
        this.connect(this.model.source.selected.properties.indices.change, () => this.updateSelection());
    }
    render() {
        super.render();
        const wait = this.setCSS();
        if (wait)
            return;
        this._initializing = true;
        const container = div({ class: "pnx-tabulator" });
        set_size(container, this.model);
        let configuration = this.getConfiguration();
        this.tabulator = new Tabulator(container, configuration);
        // Patch the ajax request method
        this.tabulator.modules = { ...this.tabulator.modules };
        const ajax = this.tabulator.modules.ajax;
        this.tabulator.modules.ajax.sendRequest = () => {
            this.requestPage(ajax.params.page, ajax.params.sorters);
        };
        // Swap pagination mode
        if (this.model.pagination === 'remote') {
            this.tabulator.options.pagination = this.model.pagination;
            this.tabulator.modules.page.mode = 'remote';
        }
        this.setGroupBy();
        this.hideColumns();
        // Set up page
        if (this.model.pagination) {
            this.setMaxPage();
            this.tabulator.setPage(this.model.page);
            this.setData();
        }
        else {
            this.freezeRows();
        }
        this.el.appendChild(container);
    }
    requestPage(page, sorters) {
        return new Promise((resolve, reject) => {
            try {
                this.model.page = page || 1;
                this.model.sorters = sorters;
                resolve({ data: [], last_page: this.model.max_page });
            }
            catch (err) {
                reject(err);
            }
        });
    }
    renderComplete() {
        // Only have to set up styles after initial render subsequent
        // styling is handled by change event on styles property
        if (this._initializing) {
            this.updateStyles();
            this.updateSelection();
        }
        this._initializing = false;
    }
    freezeRows() {
        for (const row of this.model.frozen_rows) {
            this.tabulator.getRow(row).freeze();
        }
    }
    getLayout() {
        let layout = this.model.layout;
        switch (layout) {
            case "fit_data":
                return "fitData";
            case "fit_data_fill":
                return "fitDataFill";
            case "fit_data_stretch":
                return "fitDataStretch";
            case "fit_data_table":
                return "fitDataTable";
            case "fit_columns":
                return "fitColumns";
        }
    }
    getConfiguration() {
        let configuration = {
            ...this.model.configuration,
            index: "_index",
            renderComplete: () => this.renderComplete(),
            rowSelectionChanged: (data, rows) => this.rowSelectionChanged(data, rows),
            cellEdited: (cell) => this.cellEdited(cell),
            columns: this.getColumns(),
            layout: this.getLayout(),
            ajaxURL: "http://panel.pyviz.org",
            ajaxSorting: true,
            pagination: this.model.pagination == 'remote' ? 'local' : this.model.pagination,
            paginationSize: this.model.page_size,
            paginationInitialPage: 1,
        };
        let data = this.model.source;
        if (data === null || Object.keys(data.data).length === 0)
            return configuration;
        else {
            data = transform_cds_to_records(data, true);
            return {
                ...configuration,
                "data": data,
            };
        }
    }
    getColumns() {
        const config_columns = this.model.configuration?.columns;
        let columns = [];
        if (config_columns != null) {
            for (const column of config_columns)
                if (column.columns != null) {
                    const group_columns = [];
                    for (const col of column.columns)
                        group_columns.push({ ...col });
                    columns.push({ ...column, columns: group_columns });
                }
                else {
                    columns.push({ ...column });
                }
        }
        for (const column of this.model.columns) {
            let tab_column = null;
            if (config_columns != null) {
                for (const col of columns) {
                    if (col.columns != null) {
                        for (const c of col.columns) {
                            if (column.field === c.field) {
                                tab_column = c;
                                break;
                            }
                        }
                        if (tab_column != null)
                            break;
                    }
                    else if (column.field === col.field) {
                        tab_column = col;
                        break;
                    }
                }
            }
            if (tab_column == null)
                tab_column = { field: column.field };
            if (tab_column.title == null)
                tab_column.title = column.title;
            if (tab_column.width == null && column.width != null && column.width != 0)
                tab_column.width = column.width;
            if (tab_column.formatter == null && column.formatter != null) {
                const formatter = column.formatter;
                const ftype = formatter.type;
                if (ftype === "BooleanFormatter")
                    tab_column.formatter = "tickCross";
                else {
                    tab_column.formatter = (cell) => {
                        return column.formatter.doFormat(cell.getRow(), cell, cell.getValue(), null, null);
                    };
                }
            }
            tab_column.editable = () => this.model.editable;
            const editor = column.editor;
            const ctype = editor.type;
            if (tab_column.editor != null) {
            }
            else if (ctype === "StringEditor") {
                if (editor.completions.length > 0) {
                    tab_column.editor = "autocomplete";
                    tab_column.editorParams = { values: editor.completions };
                }
                else
                    tab_column.editor = "input";
            }
            else if (ctype === "TextEditor")
                tab_column.editor = "textarea";
            else if (ctype === "IntEditor" || ctype === "NumberEditor") {
                tab_column.editor = "number";
                tab_column.editorParams = { step: editor.step };
            }
            else if (ctype === "CheckboxEditor") {
                tab_column.editor = "tickCross";
            }
            else if (ctype === "SelectEditor") {
                tab_column.editor = "select";
                tab_column.editorParams = { values: editor.options };
            }
            else {
                tab_column.editor = (cell, onRendered, success, cancel) => this.renderEditor(column, cell, onRendered, success, cancel);
            }
            if (config_columns == null)
                columns.push(tab_column);
        }
        return columns;
    }
    renderEditor(column, cell, onRendered, success, error) {
        const editor = column.editor;
        const view = new editor.default_view({ column: column, model: editor, parent: this, container: cell._cell.element });
        view.initialize();
        view.connect_signals();
        onRendered(() => {
            view.setValue(cell.getValue());
        });
        view.inputEl.addEventListener('change', () => {
            const value = view.serializeValue();
            const old_value = cell.getValue();
            const validation = view.validate();
            if (!validation.valid)
                error(validation.msg);
            if (old_value != null && typeof value != typeof old_value)
                error("Mismatching type");
            else
                success(view.serializeValue());
        });
        return view.inputEl;
    }
    after_layout() {
        super.after_layout();
        if (this.tabulator != null)
            this.tabulator.redraw(true);
        this.updateStyles();
    }
    // Update table
    setData() {
        const data = transform_cds_to_records(this.model.source, true);
        if (this.model.pagination != null)
            this.tabulator.rowManager.setData(data, true, false);
        else
            this.tabulator.setData(data);
        this.freezeRows();
        this.updateSelection();
    }
    setGroupBy() {
        if (this.model.groupby.length == 0) {
            this.tabulator.setGroupBy(false);
            return;
        }
        const groupby = (data) => {
            const groups = [];
            for (const g of this.model.groupby) {
                const group = g + ': ' + data[g];
                groups.push(group);
            }
            return groups.join(', ');
        };
        this.tabulator.setGroupBy(groupby);
    }
    setCSS() {
        let theme;
        if (this.model.theme == "default")
            theme = "tabulator";
        else
            theme = "tabulator_" + this.model.theme;
        const css = this.model.theme_url + theme + ".min.css";
        let old_node = null;
        const links = document.getElementsByTagName("link");
        const dist_index = this.model.theme_url.indexOf('dist/');
        for (const link of links) {
            if (link.href.startsWith(this.model.theme_url.slice(0, dist_index))) {
                old_node = link;
                break;
            }
        }
        let parent_node = document.getElementsByTagName("head")[0];
        if (old_node != null) {
            if (old_node.href == css)
                return false;
            if (old_node.parentNode != null)
                parent_node = old_node.parentNode;
        }
        const css_node = document.createElement('link');
        css_node.type = 'text/css';
        css_node.rel = 'stylesheet';
        css_node.media = 'screen';
        css_node.href = css;
        css_node.onload = () => {
            if (old_node != null && old_node.parentNode != null) {
                parent_node = old_node.parentNode;
                parent_node.removeChild(old_node);
            }
            this.render();
            this.update_layout();
            if (this.root == this) {
                this.compute_viewport();
                this.compute_layout();
            }
            else {
                this.compute_layout();
                this.root.resize_layout();
            }
        };
        parent_node.appendChild(css_node);
        return true;
    }
    updateStyles() {
        for (const cell_el of this._styled_cells)
            cell_el.cssText = "";
        this._styled_cells = [];
        if (this.model.styles == null || this.tabulator.getDataCount() == 0)
            return;
        for (const r in this.model.styles) {
            const row_style = this.model.styles[r];
            const row = this.tabulator.getRow(r);
            if (!row)
                continue;
            const cells = row._row.cells;
            for (const c in row_style) {
                const style = row_style[c];
                const cell = cells[c];
                if (cell == null || !style.length)
                    continue;
                const element = cell.element;
                this._styled_cells.push(element);
                element.cssText = "";
                for (const s of style) {
                    if (!s.includes(':'))
                        continue;
                    const [prop, value] = s.split(':');
                    element.style.setProperty(prop, value.trimLeft());
                }
            }
        }
    }
    addData() {
        const rows = this.tabulator.rowManager.getRows();
        const last_row = rows[rows.length - 1];
        let data = transform_cds_to_records(this.model.source, true);
        this.tabulator.setData(data);
        if (this.model.follow) {
            this.tabulator.scrollToRow((last_row.data._index || 0) + 1, "top", false);
        }
        this.freezeRows();
        this.updateSelection();
    }
    updateOrAddData() {
        // To avoid double updating the tabulator data
        if (this._tabulator_cell_updating)
            return;
        let data = transform_cds_to_records(this.model.source, true);
        this.tabulator.setData(data);
        this.freezeRows();
        this.updateSelection();
    }
    hideColumns() {
        for (const column of this.tabulator.getColumns()) {
            if (this.model.hidden_columns.indexOf(column._column.field) > -1)
                column.hide();
            else
                column.show();
        }
    }
    setMaxPage() {
        this.tabulator.setMaxPage(Math.max(this.model.page, this.model.max_page));
        this.tabulator.modules.page._setPageButtons();
    }
    setPage() {
        this.tabulator.setPage(this.model.page);
    }
    setPageSize() {
        this.tabulator.setPageSize(this.model.page_size);
    }
    updateSelection() {
        if (this.tabulator == null || this._selection_updating)
            return;
        const indices = this.model.source.selected.indices;
        this._selection_updating = true;
        this.tabulator.deselectRow();
        this.tabulator.selectRow(indices);
        this._selection_updating = false;
    }
    // Update model
    rowSelectionChanged(data, _) {
        if (this._selection_updating || this._initializing)
            return;
        this._selection_updating = true;
        const indices = data.map((row) => row._index);
        this.model.source.selected.indices = indices;
        this._selection_updating = false;
    }
    cellEdited(cell) {
        const field = cell._cell.column.field;
        const index = cell._cell.row.data._index;
        const value = cell._cell.value;
        this._tabulator_cell_updating = true;
        this.model.source.patch({ [field]: [[index, value]] });
        this._tabulator_cell_updating = false;
    }
}
DataTabulatorView.__name__ = "DataTabulatorView";
export const TableLayout = Enum("fit_data", "fit_data_fill", "fit_data_stretch", "fit_data_table", "fit_columns");
// The Bokeh .ts model corresponding to the Bokeh .py model
export class DataTabulator extends HTMLBox {
    constructor(attrs) {
        super(attrs);
    }
    static init_DataTabulator() {
        this.prototype.default_view = DataTabulatorView;
        this.define(({ Any, Array, Boolean, Nullable, Number, Ref, String }) => ({
            configuration: [Any, {}],
            columns: [Array(Ref(TableColumn)), []],
            download: [Boolean, true],
            editable: [Boolean, true],
            filename: [String, "table.csv"],
            follow: [Boolean, true],
            frozen_rows: [Array(Number), []],
            groupby: [Array(String), []],
            hidden_columns: [Array(String), []],
            layout: [TableLayout, "fit_data"],
            max_page: [Number, 0],
            pagination: [Nullable(String), null],
            page: [Number, 0],
            page_size: [Number, 0],
            source: [Ref(ColumnDataSource)],
            sorters: [Array(Any), []],
            styles: [Any, {}],
            theme: [String, "simple"],
            theme_url: [String, "https://unpkg.com/tabulator-tables@4.9.3/dist/css/"]
        }));
    }
}
DataTabulator.__name__ = "DataTabulator";
DataTabulator.__module__ = "panel.models.tabulator";
DataTabulator.init_DataTabulator();
//# sourceMappingURL=tabulator.js.map