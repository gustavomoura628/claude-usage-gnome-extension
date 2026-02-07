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
const HistoryReader = Me.imports.historyReader;

const REFRESH_INTERVAL_S = 45;
const STATUS_REFRESH_INTERVAL_S = 120;
const FIVE_HOUR_S = 5 * 3600;
const SEVEN_DAY_S = 7 * 24 * 3600;
const PANEL_BAR_WIDTH = 126;
const PANEL_BAR_HEIGHT = 12;
const DROPDOWN_BAR_WIDTH = 200;
const DROPDOWN_BAR_HEIGHT = 12;
const GRAPH_WIDTH = 280;
const GRAPH_HEIGHT = 80;
const GRAPH_MAX_POINTS = 200;
const PRO_1X_LIMITS = { '5h': 550000, '7d': 5000000 };

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

// --- History graph helpers ---

function _createHistoryGraph() {
    const area = new St.DrawingArea({
        style_class: 'claude-history-graph',
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
    });

    area._points = [];
    area._xLabels = [];
    area._noData = false;
    area._maxVal = 1;
    area._unitCredits = 0;
    area._resetTimes = [];
    area._windowPeriodMs = 0;
    area._showCumulative = false;
    area._cumMax = 0;
    area._windowStart = 0;
    area._windowEnd = 1;

    area.connect('repaint', (a) => {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        const pad = { left: 36, right: 8, top: 8, bottom: 16 };
        const gw = w - pad.left - pad.right;
        const gh = h - pad.top - pad.bottom;
        const maxVal = a._showCumulative
            ? Math.max(a._maxVal || 1, a._cumMax || 0)
            : (a._maxVal || 1);

        // Dark rounded background
        _roundedRect(cr, 0, 0, w, h, 6);
        cr.setSourceRGBA(0.165, 0.165, 0.165, 1); // #2a2a2a
        cr.fill();

        // Gridlines and Y-axis labels
        const unitCr = a._unitCredits;
        if (unitCr > 0) {
            // 1x-based gridlines
            let step = 1;
            while (unitCr * step * 5 < maxVal) step *= 2;
            cr.selectFontFace('Sans', 0, 0);
            cr.setFontSize(9);
            for (let m = step; m * unitCr <= maxVal; m += step) {
                const frac = (m * unitCr) / maxVal;
                const gy = pad.top + gh * (1 - frac);
                cr.setSourceRGBA(1, 1, 1, 0.08);
                cr.moveTo(pad.left, gy);
                cr.lineTo(pad.left + gw, gy);
                cr.stroke();
                cr.setSourceRGBA(1, 1, 1, 0.35);
                cr.moveTo(2, gy + 3);
                cr.showText(m + 'x');
            }
        } else {
            // Fallback: fixed 25/50/75/100% gridlines
            cr.setSourceRGBA(1, 1, 1, 0.08);
            for (const frac of [0.25, 0.5, 0.75, 1.0]) {
                const gy = pad.top + gh * (1 - frac);
                cr.moveTo(pad.left, gy);
                cr.lineTo(pad.left + gw, gy);
                cr.stroke();
            }
            cr.setSourceRGBA(1, 1, 1, 0.35);
            cr.selectFontFace('Sans', 0, 0);
            cr.setFontSize(9);
            const halfLabel = HistoryReader.formatCredits(maxVal * 0.5);
            const fullLabel = HistoryReader.formatCredits(maxVal);
            for (const [frac, label] of [[0.5, halfLabel], [1.0, fullLabel]]) {
                const gy = pad.top + gh * (1 - frac);
                cr.moveTo(2, gy + 3);
                cr.showText(label);
            }
        }

        // X-axis labels and tick marks — positioned by actual time
        const xLbls = a._xLabels || [];
        for (let i = 0; i < xLbls.length; i++) {
            const item = xLbls[i];
            const lx = pad.left + item.frac * gw;

            // Vertical tick mark
            cr.setSourceRGBA(1, 1, 1, 0.12);
            cr.setLineWidth(1);
            cr.moveTo(lx, pad.top);
            cr.lineTo(lx, pad.top + gh);
            cr.stroke();

            // Label text — centered on tick, clamped to graph bounds
            cr.setSourceRGBA(1, 1, 1, 0.35);
            cr.setFontSize(9);
            const ext = cr.textExtents(item.label);
            let tx = lx - ext.width / 2;
            tx = Math.max(pad.left, Math.min(pad.left + gw - ext.width, tx));
            cr.moveTo(tx, h - 2);
            cr.showText(item.label);
        }

        const pts = a._points;
        if (a._noData || pts.length === 0) {
            // "No data" centered text
            cr.setSourceRGBA(1, 1, 1, 0.3);
            cr.setFontSize(12);
            const txt = 'No data';
            const ext = cr.textExtents(txt);
            cr.moveTo(w / 2 - ext.width / 2, h / 2 + ext.height / 2);
            cr.showText(txt);
            cr.$dispose();
            return;
        }

        // Draw bars — positioned by time
        const wStart = a._windowStart || 0;
        const wEnd = a._windowEnd || 1;
        const wSpan = wEnd - wStart || 1;
        const barGap = 1;
        const baseline = pad.top + gh;

        // Green cumulative bars (behind blue bars)
        if (a._showCumulative) {
            const rTimes2 = a._resetTimes;
            let cumS = 0, rI = 0;
            for (let i = 0; i < pts.length; i++) {
                while (rI < rTimes2.length && rTimes2[rI] <= pts[i].t) { cumS = 0; rI++; }
                cumS += Math.max(0, pts[i].v);
                const cumH = Math.min(cumS, maxVal) / maxVal * gh;
                const dur = pts[i].dur || (wSpan / pts.length);
                const frac = (pts[i].t - wStart) / wSpan;
                const fracW = dur / wSpan;
                const bx = pad.left + frac * gw + barGap / 2;
                const bw = Math.max(1, fracW * gw - barGap);
                cr.rectangle(bx, baseline - cumH, bw, cumH);
                cr.setSourceRGBA(0.2, 0.7, 0.3, 1);
                cr.fill();
            }
        }

        for (let i = 0; i < pts.length; i++) {
            const v = Math.min(maxVal, Math.max(0, pts[i].v));
            const barH = (v / maxVal) * gh;
            const dur = pts[i].dur || (wSpan / pts.length);
            const frac = (pts[i].t - wStart) / wSpan;
            const fracW = dur / wSpan;
            const bx = pad.left + frac * gw + barGap / 2;
            const bw = Math.max(1, fracW * gw - barGap);

            // Bar fill
            cr.rectangle(bx, baseline - barH, bw, barH);
            cr.setSourceRGBA(0.21, 0.52, 0.89, 1);
            cr.fill();

            // Bar top edge
            if (barH > 0) {
                cr.rectangle(bx, baseline - barH, bw, 1);
                cr.setSourceRGBA(0.21, 0.52, 0.89, 0.9);
                cr.fill();
            }
        }

        // Window reset/start boundary lines
        const rTimes = a._resetTimes;
        const wPeriod = a._windowPeriodMs;
        if (rTimes.length > 0 && wPeriod > 0) {
            const resetMs = new Set(rTimes);
            const startMs = new Set(rTimes.map(t => t - wPeriod));
            // Collect all boundary positions
            const allTimes = new Set([...resetMs, ...startMs]);
            cr.setLineWidth(1);
            for (const t of allTimes) {
                const f = (t - wStart) / wSpan;
                if (f <= 0 || f >= 1) continue;
                const lx = pad.left + f * gw;
                const isReset = resetMs.has(t);
                const isStart = startMs.has(t);
                // Check near-match (within 1 min) for the other type
                const nearReset = isReset || [...resetMs].some(r => Math.abs(r - t) <= 60000);
                const nearStart = isStart || [...startMs].some(s => Math.abs(s - t) <= 60000);
                if (nearReset && nearStart)
                    cr.setSourceRGBA(0.55, 0.25, 0.85, 0.35); // purple
                else if (nearReset)
                    cr.setSourceRGBA(1, 0.3, 0.3, 0.25);      // red
                else
                    cr.setSourceRGBA(0.3, 0.5, 1, 0.25);       // blue
                cr.moveTo(lx, pad.top);
                cr.lineTo(lx, pad.top + gh);
                cr.stroke();
            }
        }

        // Dotted green line at cumulative top where green is obscured by blue
        if (a._showCumulative) {
            const rTimes3 = a._resetTimes;
            let cumS2 = 0, rI2 = 0;
            let hasDash = false;
            for (let i = 0; i < pts.length; i++) {
                while (rI2 < rTimes3.length && rTimes3[rI2] <= pts[i].t) { cumS2 = 0; rI2++; }
                cumS2 += Math.max(0, pts[i].v);
                const cumH = Math.min(cumS2, maxVal) / maxVal * gh;
                const barV = Math.min(maxVal, Math.max(0, pts[i].v));
                const barH = (barV / maxVal) * gh;
                // Only draw when green is obscured by blue and cumulative > 0
                if (cumH > 0.5 && cumH <= barH + 1) {
                    if (!hasDash) {
                        cr.setSourceRGBA(0.2, 0.7, 0.3, 0.9);
                        cr.setLineWidth(1.5);
                        cr.setDash([3, 3], 0);
                        hasDash = true;
                    }
                    const dur = pts[i].dur || (wSpan / pts.length);
                    const frac = (pts[i].t - wStart) / wSpan;
                    const fracW = dur / wSpan;
                    const bx = pad.left + frac * gw + barGap / 2;
                    const bw = Math.max(1, fracW * gw - barGap);
                    const ly = baseline - cumH;
                    cr.moveTo(bx, ly);
                    cr.lineTo(bx + bw, ly);
                    cr.stroke();
                }
            }
            if (hasDash) cr.setDash([], 0);
        }

        cr.$dispose();
    });

    return area;
}

function _formatHour(d) {
    const h = d.getHours();
    const m = d.getMinutes();
    const suffix = h >= 12 ? 'pm' : 'am';
    const h12 = h % 12 || 12;
    return m === 0 ? h12 + suffix : h12 + ':' + String(m).padStart(2, '0') + suffix;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function _computeXLabels24h(wStart, wEnd) {
    const span = wEnd - wStart || 1;
    const labels = [];
    const HOUR_LABELS = ['12am', '4am', '8am', '12pm', '4pm', '8pm'];
    const HOUR_VALUES = [0, 4, 8, 12, 16, 20];

    const d = new Date(wStart);
    d.setMinutes(0, 0, 0);
    const rem = d.getHours() % 4;
    if (rem !== 0) d.setHours(d.getHours() + (4 - rem));

    while (d.getTime() <= wEnd) {
        const frac = (d.getTime() - wStart) / span;
        if (frac >= 0 && frac <= 1) {
            const idx = HOUR_VALUES.indexOf(d.getHours());
            if (idx !== -1) {
                labels.push({ label: HOUR_LABELS[idx], frac });
            }
        }
        d.setHours(d.getHours() + 4);
    }
    return labels;
}

function _computeXLabels7d(wStart, wEnd) {
    const span = wEnd - wStart || 1;
    const labels = [];

    const d = new Date(wStart);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);

    while (d.getTime() <= wEnd) {
        const frac = (d.getTime() - wStart) / span;
        if (frac >= 0 && frac <= 1) {
            labels.push({ label: DAY_NAMES[d.getDay()], frac });
        }
        d.setDate(d.getDate() + 1);
    }
    return labels;
}

function _updateHistoryGraph(area, statsLabel, windowMs, field, labelFn, maxPoints, bucketMs, rateBucketMs, rateUnit) {
    const result = HistoryReader.readHistory(windowMs, field, maxPoints || GRAPH_MAX_POINTS, bucketMs || 0, rateBucketMs);

    if (!result.ok || result.points.length === 0) {
        area._points = [];
        area._noData = true;
        area._maxVal = 1;
        area._xLabels = labelFn(Date.now() - windowMs, Date.now());
        statsLabel.set_text('No data');
    } else {
        area._points = result.points;
        area._noData = false;
        area._windowStart = result.windowStart;
        area._windowEnd = result.windowEnd;
        area._xLabels = labelFn(result.windowStart, result.windowEnd);
        let pointMax = 0;
        for (let i = 0; i < result.points.length; i++) {
            if (result.points[i].v > pointMax) pointMax = result.points[i].v;
        }
        area._unitCredits = PRO_1X_LIMITS[field] || 0;
        area._resetTimes = result.resetTimes || [];
        area._windowPeriodMs = { '5h': 5*3600*1000, '7d': 7*24*3600*1000 }[field] || 0;
        let cumSum = 0, cumMax = 0, rIdx = 0;
        const rts = area._resetTimes;
        for (let i = 0; i < result.points.length; i++) {
            while (rIdx < rts.length && rts[rIdx] <= result.points[i].t) { cumSum = 0; rIdx++; }
            cumSum += result.points[i].v;
            if (cumSum > cumMax) cumMax = cumSum;
        }
        const minMax = area._unitCredits > 0 ? area._unitCredits * 1.15 : 0;
        area._maxVal = Math.max(pointMax > 0 ? pointMax * 1.15 : 1, minMax);
        area._cumMax = cumMax > 0 ? cumMax * 1.15 : 0;
        const fmt = HistoryReader.formatCredits;
        statsLabel.set_text(
            'avg ' + fmt(result.avgRate) + '/' + rateUnit +
            '  |  peak ' + fmt(result.peakRate) + '/' + rateUnit +
            '  |  total ' + fmt(result.total)
        );
    }

    area.queue_repaint();
}

const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Compute a calendar-aligned time range for a given offset.
 * @param {string} type - 'day' or 'week'
 * @param {number} offset - 0 = current (rolling), 1 = last complete period, etc.
 * @returns {null|{startMs: number, endMs: number, label: string}}
 */
function _computeTimeRange(type, offset) {
    if (offset === 0) return null; // use rolling window

    const now = new Date();

    if (type === 'day') {
        // Today's midnight
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);
        const endDate = new Date(today.getTime() - (offset - 1) * 86400000);
        const startDate = new Date(endDate.getTime() - 86400000);
        const d = startDate;
        const label = DAY_NAMES[d.getDay()] + ' ' + MONTH_NAMES_SHORT[d.getMonth()] + ' ' + d.getDate();
        return { startMs: startDate.getTime(), endMs: endDate.getTime(), label };
    }

    if (type === 'week') {
        // Find most recent Sunday at midnight
        const thisSunday = new Date(now);
        thisSunday.setHours(0, 0, 0, 0);
        thisSunday.setDate(thisSunday.getDate() - thisSunday.getDay()); // roll back to Sunday
        const endDate = new Date(thisSunday.getTime() - (offset - 1) * 7 * 86400000);
        const startDate = new Date(endDate.getTime() - 7 * 86400000);
        const s = startDate;
        const e = new Date(endDate.getTime() - 86400000); // Saturday
        const label = MONTH_NAMES_SHORT[s.getMonth()] + ' ' + s.getDate() +
            ' \u2013 ' + MONTH_NAMES_SHORT[e.getMonth()] + ' ' + e.getDate();
        return { startMs: startDate.getTime(), endMs: endDate.getTime(), label };
    }

    return null;
}

function _updateHistoryGraphRange(area, statsLabel, startMs, endMs, field, labelFn, bucketMs, rateBucketMs, rateUnit) {
    const result = HistoryReader.readHistoryRange(startMs, endMs, field, bucketMs, rateBucketMs);

    if (!result.ok || result.points.length === 0) {
        area._points = [];
        area._noData = true;
        area._maxVal = 1;
        area._xLabels = labelFn(startMs, endMs);
        statsLabel.set_text('No data');
    } else {
        area._points = result.points;
        area._noData = false;
        area._windowStart = result.windowStart;
        area._windowEnd = result.windowEnd;
        area._xLabels = labelFn(result.windowStart, result.windowEnd);
        let pointMax = 0;
        for (let i = 0; i < result.points.length; i++) {
            if (result.points[i].v > pointMax) pointMax = result.points[i].v;
        }
        area._unitCredits = PRO_1X_LIMITS[field] || 0;
        area._resetTimes = result.resetTimes || [];
        area._windowPeriodMs = { '5h': 5*3600*1000, '7d': 7*24*3600*1000 }[field] || 0;
        let cumSum = 0, cumMax = 0, rIdx = 0;
        const rts = area._resetTimes;
        for (let i = 0; i < result.points.length; i++) {
            while (rIdx < rts.length && rts[rIdx] <= result.points[i].t) { cumSum = 0; rIdx++; }
            cumSum += result.points[i].v;
            if (cumSum > cumMax) cumMax = cumSum;
        }
        const minMax = area._unitCredits > 0 ? area._unitCredits * 1.15 : 0;
        area._maxVal = Math.max(pointMax > 0 ? pointMax * 1.15 : 1, minMax);
        area._cumMax = cumMax > 0 ? cumMax * 1.15 : 0;
        const fmt = HistoryReader.formatCredits;
        statsLabel.set_text(
            'avg ' + fmt(result.avgRate) + '/' + rateUnit +
            '  |  peak ' + fmt(result.peakRate) + '/' + rateUnit +
            '  |  total ' + fmt(result.total)
        );
    }

    area.queue_repaint();
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
        this._refreshingToken = false;
        this._pendingRefreshMessage = null;

        // Navigation offsets for history graphs (0 = rolling window, 1+ = calendar-aligned past periods)
        this._graph5hOffset = 0;
        this._graph7dOffset = 0;
        this._showCumulative = false;

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
                this._loadHistoryGraphs();
            } else {
                this._stopCountdown();
                this._graph5hOffset = 0;
                this._graph7dOffset = 0;
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

        // --- Usage History section ---
        const historyHeaderRow = new St.BoxLayout({ x_expand: true });
        historyHeaderRow.add_child(new St.Label({
            style_class: 'claude-dropdown-section-label',
            text: 'Usage History',
            x_expand: true,
        }));
        this._cumToggle = new St.Label({
            style_class: 'claude-history-nav-arrow',
            text: '\u03A3',
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._cumToggle.connect('button-press-event', () => {
            this._showCumulative = !this._showCumulative;
            this._cumToggle.style_class = this._showCumulative
                ? 'claude-history-nav-arrow claude-toggle-active'
                : 'claude-history-nav-arrow';
            this._graph5h._showCumulative = this._showCumulative;
            this._graph7d._showCumulative = this._showCumulative;
            this._graph5h.queue_repaint();
            this._graph7d.queue_repaint();
            return Clutter.EVENT_STOP;
        });
        historyHeaderRow.add_child(this._cumToggle);
        dropBox.add_child(historyHeaderRow);

        // 5h graph — title + nav on same row
        const navRow5h = new St.BoxLayout({
            style_class: 'claude-history-nav-row',
            x_expand: true,
        });
        navRow5h.add_child(new St.Label({
            style_class: 'claude-history-graph-title',
            text: 'Credit Rate \u2013 30min Buckets (24h)',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));
        this._navLeft5h = new St.Label({
            style_class: 'claude-history-nav-arrow',
            text: '\u25C0',
            reactive: true,
            track_hover: true,
        });
        this._navLeft5h.connect('button-press-event', () => {
            this._graph5hOffset++;
            this._loadGraph5h();
            return Clutter.EVENT_STOP;
        });
        this._navLabel5h = new St.Label({
            style_class: 'claude-history-nav-label',
            text: 'Today',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._navRight5h = new St.Label({
            style_class: 'claude-history-nav-arrow',
            text: '\u25B6',
            reactive: true,
            track_hover: true,
            opacity: 0,
        });
        this._navRight5h.connect('button-press-event', () => {
            if (this._graph5hOffset > 0) {
                this._graph5hOffset--;
                this._loadGraph5h();
            }
            return Clutter.EVENT_STOP;
        });
        navRow5h.add_child(this._navLeft5h);
        navRow5h.add_child(this._navLabel5h);
        navRow5h.add_child(this._navRight5h);
        dropBox.add_child(navRow5h);

        this._graph5h = _createHistoryGraph();
        dropBox.add_child(this._graph5h);
        this._graphStats5h = new St.Label({
            style_class: 'claude-history-stats',
            text: '',
        });
        dropBox.add_child(this._graphStats5h);

        // Divider between graphs
        dropBox.add_child(new St.Widget({
            style_class: 'claude-history-graph-divider',
        }));

        // 7d graph — title + nav on same row
        const navRow7d = new St.BoxLayout({
            style_class: 'claude-history-nav-row',
            x_expand: true,
        });
        navRow7d.add_child(new St.Label({
            style_class: 'claude-history-graph-title',
            text: 'Credit Rate \u2013 Daily Buckets (7d)',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));
        this._navLeft7d = new St.Label({
            style_class: 'claude-history-nav-arrow',
            text: '\u25C0',
            reactive: true,
            track_hover: true,
        });
        this._navLeft7d.connect('button-press-event', () => {
            this._graph7dOffset++;
            this._loadGraph7d();
            return Clutter.EVENT_STOP;
        });
        this._navLabel7d = new St.Label({
            style_class: 'claude-history-nav-label',
            text: 'This week',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._navRight7d = new St.Label({
            style_class: 'claude-history-nav-arrow',
            text: '\u25B6',
            reactive: true,
            track_hover: true,
            opacity: 0,
        });
        this._navRight7d.connect('button-press-event', () => {
            if (this._graph7dOffset > 0) {
                this._graph7dOffset--;
                this._loadGraph7d();
            }
            return Clutter.EVENT_STOP;
        });
        navRow7d.add_child(this._navLeft7d);
        navRow7d.add_child(this._navLabel7d);
        navRow7d.add_child(this._navRight7d);
        dropBox.add_child(navRow7d);

        this._graph7d = _createHistoryGraph();
        dropBox.add_child(this._graph7d);
        this._graphStats7d = new St.Label({
            style_class: 'claude-history-stats',
            text: '',
        });
        dropBox.add_child(this._graphStats7d);

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

        // Proactive refresh: if token expires within 5 minutes, refresh first
        if (cred.expiresAt) {
            const expiresMs = new Date(cred.expiresAt).getTime();
            const nowMs = Date.now();
            if (expiresMs - nowMs < 5 * 60 * 1000) {
                this._tryTokenRefresh();
                return;
            }
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
                // Reactive refresh: on auth-error, try refreshing the token
                if (error === 'auth-error') {
                    this._tryTokenRefresh();
                    return;
                }
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

    _tryTokenRefresh() {
        if (this._refreshingToken) return;
        this._refreshingToken = true;

        // Show refreshing state
        this._lastError = 'auth-refreshing';
        this._updatePanel();
        if (this.menu.isOpen) {
            this._updateDropdown();
        }

        const cred = CredentialReader.readToken();
        if (!cred.ok || !cred.refreshToken) {
            this._refreshingToken = false;
            this._lastError = 'auth-error';
            this._updatePanel();
            if (this.menu.isOpen) {
                this._updateDropdown();
            }
            return;
        }

        this._pendingRefreshMessage = ApiClient.refreshToken(cred.refreshToken, (error, data) => {
            this._pendingRefreshMessage = null;
            this._refreshingToken = false;

            if (error === 'cancelled') return;

            if (error || !data || !data.access_token) {
                this._lastError = 'auth-error';
                this._updatePanel();
                if (this.menu.isOpen) {
                    this._updateDropdown();
                }
                return;
            }

            // Compute expiresAt from expires_in (seconds from now)
            const expiresAt = data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000).toISOString()
                : null;

            // Persist updated tokens
            const writeResult = CredentialReader.writeToken(
                data.access_token,
                data.refresh_token || cred.refreshToken,
                expiresAt
            );

            if (!writeResult.ok) {
                this._lastError = 'auth-error';
                this._updatePanel();
                if (this.menu.isOpen) {
                    this._updateDropdown();
                }
                return;
            }

            // Retry the usage fetch with the new token
            this._refresh();
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
                case 'auth-refreshing':
                    errMsg = 'Token expired. Refreshing...';
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

    _loadGraph5h() {
        const MIN_MS = 60 * 1000;
        const HOUR_MS = 3600 * 1000;

        const range = _computeTimeRange('day', this._graph5hOffset);
        if (!range) {
            // Rolling window (offset 0)
            _updateHistoryGraph(this._graph5h, this._graphStats5h, 24 * HOUR_MS, '5h', _computeXLabels24h, 0, 30 * MIN_MS, HOUR_MS, 'hr');
            this._navLabel5h.set_text('Today');
            this._navRight5h.opacity = 0;
            this._navRight5h.reactive = false;
        } else {
            _updateHistoryGraphRange(this._graph5h, this._graphStats5h, range.startMs, range.endMs, '5h', _computeXLabels24h, 30 * MIN_MS, HOUR_MS, 'hr');
            this._navLabel5h.set_text(range.label);
            this._navRight5h.opacity = 255;
            this._navRight5h.reactive = true;
        }
    }

    _loadGraph7d() {
        const HOUR_MS = 3600 * 1000;
        const DAY_MS = 24 * HOUR_MS;

        const range = _computeTimeRange('week', this._graph7dOffset);
        if (!range) {
            // Rolling window (offset 0)
            _updateHistoryGraph(this._graph7d, this._graphStats7d, 7 * DAY_MS, '7d', _computeXLabels7d, 0, DAY_MS, DAY_MS, 'day');
            this._navLabel7d.set_text('This week');
            this._navRight7d.opacity = 0;
            this._navRight7d.reactive = false;
        } else {
            _updateHistoryGraphRange(this._graph7d, this._graphStats7d, range.startMs, range.endMs, '7d', _computeXLabels7d, DAY_MS, DAY_MS, 'day');
            this._navLabel7d.set_text(range.label);
            this._navRight7d.opacity = 255;
            this._navRight7d.reactive = true;
        }
    }

    _loadHistoryGraphs() {
        this._loadGraph5h();
        this._loadGraph7d();
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
        if (this._pendingRefreshMessage) {
            ApiClient.cancelMessage(this._pendingRefreshMessage);
            this._pendingRefreshMessage = null;
        }

        super.destroy();
    }
});
