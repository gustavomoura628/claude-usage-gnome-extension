'use strict';

const { Clutter, Gio, GLib, GObject, St } = imports.gi;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const ApiClient = Me.imports.apiClient;
const CredentialReader = Me.imports.credentialReader;
const UsageLogger = Me.imports.usageLogger;

const REFRESH_INTERVAL_S = 45;
const STATUS_REFRESH_INTERVAL_S = 120;
const FIVE_HOUR_S = 5 * 3600;
const SEVEN_DAY_S = 7 * 24 * 3600;
const PANEL_BAR_WIDTH = 126;
const PANEL_BAR_HEIGHT = 12;
const DROPDOWN_BAR_WIDTH = 200;
const DROPDOWN_BAR_HEIGHT = 12;

function _getBarColorClass(pct, prefix) {
    if (pct >= 80) return prefix + '-red';
    if (pct >= 50) return prefix + '-amber';
    return prefix + '-blue';
}

function _formatCountdown(resetIso) {
    if (!resetIso) return '';
    const resetMs = new Date(resetIso).getTime();
    const nowMs = Date.now();
    const diffS = Math.max(0, Math.floor((resetMs - nowMs) / 1000));
    if (diffS <= 0) return 'Resetting...';

    const days = Math.floor(diffS / 86400);
    const hours = Math.floor((diffS % 86400) / 3600);
    const mins = Math.floor((diffS % 3600) / 60);

    if (days > 0) return 'Resets in ' + days + 'd ' + hours + 'h';
    if (hours > 0) return 'Resets in ' + hours + 'h ' + mins + 'm';
    return 'Resets in ' + mins + 'm';
}

function _formatPanelCountdown5h(resetIso) {
    if (!resetIso) return '5h';
    const diffS = Math.max(0, Math.floor((new Date(resetIso).getTime() - Date.now()) / 1000));
    if (diffS <= 0) return '0m';
    const hours = Math.floor(diffS / 3600);
    const mins = Math.floor((diffS % 3600) / 60);
    if (hours > 0) return hours + 'h' + (mins > 0 ? mins + 'm' : '');
    return mins + 'm';
}

function _formatPanelCountdown7d(resetIso) {
    if (!resetIso) return '7d';
    const diffS = Math.max(0, Math.floor((new Date(resetIso).getTime() - Date.now()) / 1000));
    if (diffS <= 0) return '0m';
    const days = Math.floor(diffS / 86400);
    const hours = Math.floor((diffS % 86400) / 3600);
    const mins = Math.floor((diffS % 3600) / 60);
    if (days > 0) return days + 'd' + (hours > 0 ? hours + 'h' : '');
    if (hours > 0) return hours + 'h' + (mins > 0 ? mins + 'm' : '');
    return mins + 'm';
}

function _timeMarkerFraction(resetIso, windowSeconds) {
    if (!resetIso) return 0;
    const resetMs = new Date(resetIso).getTime();
    const nowMs = Date.now();
    const timeUntilReset = Math.max(0, (resetMs - nowMs) / 1000);
    return Math.min(1, Math.max(0, 1 - timeUntilReset / windowSeconds));
}

// --- Panel progress bar (compact) ---

function _createPanelBar() {
    const track = new St.DrawingArea({
        style_class: 'claude-bar-track',
        width: PANEL_BAR_WIDTH,
        height: PANEL_BAR_HEIGHT,
    });

    // Store drawing state on the actor itself
    track._fillPct = 0;
    track._fillColor = [0.21, 0.52, 0.89]; // blue
    track._markerPos = -1; // -1 = hidden

    track.connect('repaint', (area) => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const r = h / 2;

        // Clip everything to the rounded track shape
        _roundedRect(cr, 0, 0, w, h, r);
        cr.clip();

        // Track background
        cr.setSourceRGBA(0.24, 0.24, 0.24, 1);
        cr.paint();

        // Fill — simple rectangle, clipped by the track shape
        const fw = Math.round((track._fillPct / 100) * w);
        if (fw > 0) {
            const c = track._fillColor;
            cr.setSourceRGBA(c[0], c[1], c[2], 1);
            cr.rectangle(0, 0, fw, h);
            cr.fill();
        }

        // Time marker
        if (track._markerPos >= 0 && track._markerPos <= 1) {
            const mx = Math.round(track._markerPos * w);
            cr.setSourceRGBA(1, 1, 1, 0.85);
            cr.rectangle(mx - 1, 0, 2, h);
            cr.fill();
        }

        cr.$dispose();
    });

    return { track };
}

function _roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

function _updatePanelBar(bar, pct, markerFraction) {
    bar.track._fillPct = pct;
    bar.track._markerPos = (markerFraction > 0 && markerFraction < 1) ? markerFraction : -1;

    if (pct >= 80) bar.track._fillColor = [0.88, 0.11, 0.14]; // red
    else if (pct >= 50) bar.track._fillColor = [0.90, 0.65, 0.04]; // amber
    else bar.track._fillColor = [0.21, 0.52, 0.89]; // blue

    bar.track.queue_repaint();
}

// --- Dropdown progress bar (larger) ---

function _createDropdownBar() {
    const track = new St.Widget({
        style_class: 'claude-dropdown-bar-track',
        width: DROPDOWN_BAR_WIDTH,
        height: DROPDOWN_BAR_HEIGHT,
    });

    const fill = new St.Widget({
        style_class: 'claude-dropdown-bar-fill claude-bar-fill-blue',
        height: DROPDOWN_BAR_HEIGHT,
        width: 0,
    });
    track.add_child(fill);

    const marker = new St.Widget({
        style_class: 'claude-dropdown-bar-marker',
        height: DROPDOWN_BAR_HEIGHT,
        width: 2,
        visible: false,
    });
    track.add_child(marker);

    return { track, fill, marker };
}

function _updateDropdownBar(bar, pct, markerFraction) {
    const fillWidth = Math.round((pct / 100) * DROPDOWN_BAR_WIDTH);
    bar.fill.set_width(Math.max(0, Math.min(DROPDOWN_BAR_WIDTH, fillWidth)));

    const colorClass = _getBarColorClass(pct, 'claude-bar-fill');
    bar.fill.style_class = 'claude-dropdown-bar-fill ' + colorClass;

    if (markerFraction > 0 && markerFraction < 1) {
        const markerX = Math.round(markerFraction * DROPDOWN_BAR_WIDTH) - 1;
        bar.marker.set_position(Math.max(0, markerX), 0);
        bar.marker.visible = true;
    } else {
        bar.marker.visible = false;
    }
}

// ---- Main indicator class ----

var ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Claude Usage', false);

        this._lastData = null;
        this._lastError = null;
        this._lastFetchTime = 0;
        this._refreshTimerId = null;
        this._countdownTimerId = null;
        this._pendingMessage = null;

        this._lastStatusData = null;
        this._pendingStatusMessage = null;
        this._statusTimerId = null;

        this._buildPanelWidget();
        this._buildDropdownMenu();

        // Position: right box, index 0 → right after the center clock
        Main.panel.addToStatusArea('claude-usage', this, 0, 'right');

        // Dark mode for the dropdown
        this.menu.box.add_style_class_name('claude-dropdown-menu');

        // Connect dropdown open/close for countdown timer
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._startCountdown();
                this._updateDropdown();
            } else {
                this._stopCountdown();
            }
        });

        this._panelTimerId = null;

        // Initial fetch
        this._refresh();

        // Periodic refresh
        this._refreshTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL_S, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });

        // Update panel countdown labels every 60s
        this._panelTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._updatePanel();
            return GLib.SOURCE_CONTINUE;
        });

        // Initial status fetch
        this._refreshStatus();

        // Periodic status refresh (120s)
        this._statusTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, STATUS_REFRESH_INTERVAL_S, () => {
            this._refreshStatus();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _buildPanelWidget() {
        const box = new St.BoxLayout({
            style_class: 'claude-panel-box panel-status-indicators-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // 5h countdown + bar + pct
        this._panelLabel5h = new St.Label({
            style_class: 'claude-bar-label',
            text: '5h',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });
        box.add_child(this._panelLabel5h);

        this._panelBar5h = _createPanelBar();
        box.add_child(this._panelBar5h.track);

        this._panelPct5h = new St.Label({
            style_class: 'claude-pct-label',
            text: '--%',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._panelPct5h);

        // Separator
        box.add_child(new St.Widget({
            style_class: 'claude-separator',
            height: 14,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        // 7d countdown + bar + pct
        this._panelLabel7d = new St.Label({
            style_class: 'claude-bar-label',
            text: '7d',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });
        box.add_child(this._panelLabel7d);

        this._panelBar7d = _createPanelBar();
        box.add_child(this._panelBar7d.track);

        this._panelPct7d = new St.Label({
            style_class: 'claude-pct-label',
            text: '--%',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._panelPct7d);

        // Status dot
        this._statusDot = new St.Widget({
            style_class: 'claude-status-dot claude-dot-operational',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._statusDot);

        this.add_child(box);
    }

    _buildDropdownMenu() {
        // Custom menu item with a box layout
        const menuItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const dropBox = new St.BoxLayout({
            style_class: 'claude-dropdown-box',
            vertical: true,
        });
        menuItem.add_child(dropBox);

        // Header
        dropBox.add_child(new St.Label({
            style_class: 'claude-dropdown-header',
            text: 'Claude Usage',
        }));

        // --- 5-Hour section ---
        dropBox.add_child(new St.Label({
            style_class: 'claude-dropdown-section-label',
            text: '5-Hour Session',
        }));

        this._ddBar5h = _createDropdownBar();
        const barRow5h = new St.BoxLayout({ style_class: 'claude-dropdown-bar-row' });
        barRow5h.add_child(this._ddBar5h.track);
        this._ddPct5h = new St.Label({
            style_class: 'claude-dropdown-pct',
            text: '--%',
            y_align: Clutter.ActorAlign.CENTER,
        });
        barRow5h.add_child(this._ddPct5h);
        dropBox.add_child(barRow5h);

        this._ddReset5h = new St.Label({
            style_class: 'claude-dropdown-reset',
            text: '',
        });
        dropBox.add_child(this._ddReset5h);

        // --- 7-Day section ---
        dropBox.add_child(new St.Label({
            style_class: 'claude-dropdown-section-label',
            text: '7-Day Rolling',
        }));

        this._ddBar7d = _createDropdownBar();
        const barRow7d = new St.BoxLayout({ style_class: 'claude-dropdown-bar-row' });
        barRow7d.add_child(this._ddBar7d.track);
        this._ddPct7d = new St.Label({
            style_class: 'claude-dropdown-pct',
            text: '--%',
            y_align: Clutter.ActorAlign.CENTER,
        });
        barRow7d.add_child(this._ddPct7d);
        dropBox.add_child(barRow7d);

        this._ddReset7d = new St.Label({
            style_class: 'claude-dropdown-reset',
            text: '',
        });
        dropBox.add_child(this._ddReset7d);

        // --- Per-model breakdown ---
        this._ddModelSection = new St.BoxLayout({ vertical: true, visible: false });

        dropBox.add_child(new St.Label({
            style_class: 'claude-dropdown-section-label',
            text: 'Per-Model (7d)',
        }));

        this._ddSonnetRow = new St.BoxLayout({ style_class: 'claude-dropdown-model-row', visible: false });
        this._ddSonnetLabel = new St.Label({ style_class: 'claude-dropdown-model-label', text: 'Sonnet' });
        this._ddSonnetPct = new St.Label({ style_class: 'claude-dropdown-model-pct', text: '' });
        this._ddSonnetRow.add_child(this._ddSonnetLabel);
        this._ddSonnetRow.add_child(this._ddSonnetPct);
        this._ddModelSection.add_child(this._ddSonnetRow);

        this._ddOpusRow = new St.BoxLayout({ style_class: 'claude-dropdown-model-row', visible: false });
        this._ddOpusLabel = new St.Label({ style_class: 'claude-dropdown-model-label', text: 'Opus' });
        this._ddOpusPct = new St.Label({ style_class: 'claude-dropdown-model-pct', text: '' });
        this._ddOpusRow.add_child(this._ddOpusLabel);
        this._ddOpusRow.add_child(this._ddOpusPct);
        this._ddModelSection.add_child(this._ddOpusRow);

        this._ddCoworkRow = new St.BoxLayout({ style_class: 'claude-dropdown-model-row', visible: false });
        this._ddCoworkLabel = new St.Label({ style_class: 'claude-dropdown-model-label', text: 'Cowork' });
        this._ddCoworkPct = new St.Label({ style_class: 'claude-dropdown-model-pct', text: '' });
        this._ddCoworkRow.add_child(this._ddCoworkLabel);
        this._ddCoworkRow.add_child(this._ddCoworkPct);
        this._ddModelSection.add_child(this._ddCoworkRow);

        dropBox.add_child(this._ddModelSection);

        // --- Service Status section ---
        dropBox.add_child(new St.Label({
            style_class: 'claude-dropdown-section-label',
            text: 'Service Status',
        }));

        this._ddStatusSection = new St.BoxLayout({ vertical: true });

        // Component rows: claude.ai, API, Claude Code
        this._ddComponentRows = [];
        const componentNames = ['claude.ai', 'Claude API (api.anthropic.com)', 'Claude Code'];
        const componentLabels = ['claude.ai', 'API', 'Claude Code'];
        for (let i = 0; i < componentNames.length; i++) {
            const row = new St.BoxLayout({ style_class: 'claude-dropdown-component-row' });
            const dot = new St.Widget({
                style_class: 'claude-dropdown-component-dot claude-dot-operational',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const name = new St.Label({
                style_class: 'claude-dropdown-component-name',
                text: componentLabels[i],
                y_align: Clutter.ActorAlign.CENTER,
            });
            const status = new St.Label({
                style_class: 'claude-dropdown-component-status',
                text: 'Operational',
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(dot);
            row.add_child(name);
            row.add_child(status);
            this._ddStatusSection.add_child(row);
            this._ddComponentRows.push({ apiName: componentNames[i], dot, status });
        }

        this._ddIncidentLabel = new St.Label({
            style_class: 'claude-dropdown-incident',
            text: '',
            visible: false,
        });
        this._ddStatusSection.add_child(this._ddIncidentLabel);

        const statusLink = new St.Label({
            style_class: 'claude-dropdown-status-link',
            text: 'status.claude.com',
            reactive: true,
            track_hover: true,
        });
        statusLink.connect('button-press-event', () => {
            Gio.AppInfo.launch_default_for_uri('https://status.claude.com', null);
            this.menu.close();
            return Clutter.EVENT_STOP;
        });
        this._ddStatusSection.add_child(statusLink);

        dropBox.add_child(this._ddStatusSection);

        // --- Error line ---
        this._ddError = new St.Label({
            style_class: 'claude-dropdown-error',
            text: '',
            visible: false,
        });
        dropBox.add_child(this._ddError);

        // --- Separator + Refresh button ---
        this.menu.addMenuItem(menuItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh Now');
        refreshItem.connect('activate', () => {
            this._refresh();
        });
        this.menu.addMenuItem(refreshItem);

        // --- Status line ---
        const statusItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        this._ddStatus = new St.Label({
            style_class: 'claude-dropdown-status',
            text: '',
        });
        statusItem.add_child(this._ddStatus);
        this.menu.addMenuItem(statusItem);
    }

    _refresh() {
        const cred = CredentialReader.readToken();
        if (!cred.ok) {
            this._lastError = cred.error;
            this._lastData = null;
            this._updatePanel();
            this._updateDropdown();
            return;
        }

        // Cancel any pending request
        if (this._pendingMessage) {
            ApiClient.cancelMessage(this._pendingMessage);
            this._pendingMessage = null;
        }

        const credInfo = { plan: cred.plan, tier: cred.tier };

        this._pendingMessage = ApiClient.fetchUsage(cred.token, (error, data) => {
            this._pendingMessage = null;

            if (error === 'cancelled') return;

            if (error) {
                this._lastError = error;
            } else {
                this._lastError = null;
                this._lastData = data;
                this._lastFetchTime = Date.now();
                UsageLogger.maybeLog(data, credInfo);
            }

            this._updatePanel();
            if (this.menu.isOpen) {
                this._updateDropdown();
            }
        });
    }

    _updatePanel() {
        if (this._lastError) {
            const isCredError = this._lastError === 'no-credentials' ||
                                this._lastError === 'no-token' ||
                                this._lastError === 'parse-error';
            this._panelLabel5h.set_text('5h');
            this._panelLabel7d.set_text('7d');
            this._panelPct5h.set_text(isCredError ? '--' : '!');
            this._panelPct7d.set_text(isCredError ? '--' : '!');
            _updatePanelBar(this._panelBar5h, 0, 0);
            _updatePanelBar(this._panelBar7d, 0, 0);
            return;
        }

        if (!this._lastData) return;

        const d = this._lastData;
        const pct5h = Math.round(d.five_hour ? d.five_hour.utilization : 0);
        const pct7d = Math.round(d.seven_day ? d.seven_day.utilization : 0);

        this._panelLabel5h.set_text(d.five_hour ? _formatPanelCountdown5h(d.five_hour.resets_at) : '5h');
        this._panelLabel7d.set_text(d.seven_day ? _formatPanelCountdown7d(d.seven_day.resets_at) : '7d');
        this._panelPct5h.set_text(pct5h + '%');
        this._panelPct7d.set_text(pct7d + '%');

        const marker5h = d.five_hour ? _timeMarkerFraction(d.five_hour.resets_at, FIVE_HOUR_S) : 0;
        const marker7d = d.seven_day ? _timeMarkerFraction(d.seven_day.resets_at, SEVEN_DAY_S) : 0;

        _updatePanelBar(this._panelBar5h, pct5h, marker5h);
        _updatePanelBar(this._panelBar7d, pct7d, marker7d);
    }

    _updateDropdown() {
        // Error display
        if (this._lastError) {
            let errMsg = '';
            switch (this._lastError) {
                case 'no-credentials':
                case 'no-token':
                case 'read-failed':
                    errMsg = 'No credentials. Is Claude Code installed?';
                    break;
                case 'auth-error':
                    errMsg = 'Token expired. Run Claude Code to refresh.';
                    break;
                case 'parse-error':
                    errMsg = 'Failed to parse response.';
                    break;
                default:
                    errMsg = 'API unreachable. Will retry.';
            }
            this._ddError.set_text(errMsg);
            this._ddError.visible = true;
        } else {
            this._ddError.visible = false;
        }

        if (!this._lastData) return;

        const d = this._lastData;

        // 5h
        const pct5h = Math.round(d.five_hour ? d.five_hour.utilization : 0);
        const marker5h = d.five_hour ? _timeMarkerFraction(d.five_hour.resets_at, FIVE_HOUR_S) : 0;
        _updateDropdownBar(this._ddBar5h, pct5h, marker5h);
        this._ddPct5h.set_text(pct5h + '%');
        this._ddReset5h.set_text(d.five_hour ? _formatCountdown(d.five_hour.resets_at) : '');

        // 7d
        const pct7d = Math.round(d.seven_day ? d.seven_day.utilization : 0);
        const marker7d = d.seven_day ? _timeMarkerFraction(d.seven_day.resets_at, SEVEN_DAY_S) : 0;
        _updateDropdownBar(this._ddBar7d, pct7d, marker7d);
        this._ddPct7d.set_text(pct7d + '%');
        this._ddReset7d.set_text(d.seven_day ? _formatCountdown(d.seven_day.resets_at) : '');

        // Per-model breakdown
        let anyModel = false;

        if (d.seven_day_sonnet && d.seven_day_sonnet.utilization != null) {
            this._ddSonnetPct.set_text(Math.round(d.seven_day_sonnet.utilization) + '%');
            this._ddSonnetRow.visible = true;
            anyModel = true;
        } else {
            this._ddSonnetRow.visible = false;
        }

        if (d.seven_day_opus && d.seven_day_opus.utilization != null) {
            this._ddOpusPct.set_text(Math.round(d.seven_day_opus.utilization) + '%');
            this._ddOpusRow.visible = true;
            anyModel = true;
        } else {
            this._ddOpusRow.visible = false;
        }

        if (d.seven_day_cowork && d.seven_day_cowork.utilization != null) {
            this._ddCoworkPct.set_text(Math.round(d.seven_day_cowork.utilization) + '%');
            this._ddCoworkRow.visible = true;
            anyModel = true;
        } else {
            this._ddCoworkRow.visible = false;
        }

        this._ddModelSection.visible = anyModel;

        // Service status
        this._updateStatusDropdown();

        // Status
        if (this._lastFetchTime > 0) {
            const ago = Math.round((Date.now() - this._lastFetchTime) / 1000);
            this._ddStatus.set_text('Last updated: ' + ago + 's ago');
        }
    }

    _refreshStatus() {
        if (this._pendingStatusMessage) {
            ApiClient.cancelMessage(this._pendingStatusMessage);
            this._pendingStatusMessage = null;
        }

        this._pendingStatusMessage = ApiClient.fetchStatus((error, data) => {
            this._pendingStatusMessage = null;
            if (error === 'cancelled') return;

            if (!error && data) {
                this._lastStatusData = data;
                this._updateStatusDot();
                if (this.menu.isOpen) {
                    this._updateStatusDropdown();
                }
            }
        });
    }

    _updateStatusDot() {
        if (!this._lastStatusData || !this._lastStatusData.status) return;

        const indicator = this._lastStatusData.status.indicator;
        let dotClass = 'claude-dot-operational';
        if (indicator === 'critical') dotClass = 'claude-dot-critical';
        else if (indicator === 'major') dotClass = 'claude-dot-major';
        else if (indicator === 'minor') dotClass = 'claude-dot-minor';
        else if (indicator === 'maintenance') dotClass = 'claude-dot-degraded';

        this._statusDot.style_class = 'claude-status-dot ' + dotClass;
    }

    _updateStatusDropdown() {
        if (!this._lastStatusData) return;

        const components = this._lastStatusData.components || [];
        for (const row of this._ddComponentRows) {
            const comp = components.find(c => c.name === row.apiName);
            if (comp) {
                const statusText = comp.status.replace(/_/g, ' ');
                row.status.set_text(statusText.charAt(0).toUpperCase() + statusText.slice(1));

                let dotClass = 'claude-dot-operational';
                if (comp.status === 'major_outage') dotClass = 'claude-dot-critical';
                else if (comp.status === 'partial_outage') dotClass = 'claude-dot-minor';
                else if (comp.status === 'degraded_performance') dotClass = 'claude-dot-degraded';
                else if (comp.status === 'under_maintenance') dotClass = 'claude-dot-degraded';

                row.dot.style_class = 'claude-dropdown-component-dot ' + dotClass;
            }
        }

        const incidents = this._lastStatusData.incidents || [];
        if (incidents.length > 0) {
            const texts = incidents.map(inc => inc.name + ' (' + inc.status + ')');
            this._ddIncidentLabel.set_text(texts.join('\n'));
            this._ddIncidentLabel.visible = true;
        } else {
            this._ddIncidentLabel.visible = false;
        }
    }

    _startCountdown() {
        this._stopCountdown();
        this._countdownTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateDropdown();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopCountdown() {
        if (this._countdownTimerId) {
            GLib.source_remove(this._countdownTimerId);
            this._countdownTimerId = null;
        }
    }

    destroy() {
        if (this._refreshTimerId) {
            GLib.source_remove(this._refreshTimerId);
            this._refreshTimerId = null;
        }
        if (this._panelTimerId) {
            GLib.source_remove(this._panelTimerId);
            this._panelTimerId = null;
        }
        if (this._statusTimerId) {
            GLib.source_remove(this._statusTimerId);
            this._statusTimerId = null;
        }
        this._stopCountdown();

        if (this._pendingMessage) {
            ApiClient.cancelMessage(this._pendingMessage);
            this._pendingMessage = null;
        }
        if (this._pendingStatusMessage) {
            ApiClient.cancelMessage(this._pendingStatusMessage);
            this._pendingStatusMessage = null;
        }

        super.destroy();
    }
});
