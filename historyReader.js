'use strict';

const { Gio, GLib } = imports.gi;

const LOG_DIR_NAME = 'claude-usage';
const LOG_FILE_NAME = 'history.jsonl';

// Credit limits per tier from https://she-llac.com/claude-limits
const TIER_LIMITS = {
    'default_claude_max_5x':  { '5h': 3300000,  '7d': 41666700 },
    'default_claude_max_20x': { '5h': 11000000, '7d': 83333300 },
};
const DEFAULT_LIMITS = { '5h': 550000, '7d': 5000000 }; // Pro

function _getLimits(tier) {
    if (tier && TIER_LIMITS[tier]) return TIER_LIMITS[tier];
    return DEFAULT_LIMITS;
}

function _getLogPath() {
    const dataDir = GLib.get_user_data_dir();
    return GLib.build_filenamev([dataDir, LOG_DIR_NAME, LOG_FILE_NAME]);
}

/**
 * Format a credit value for display (e.g. 1500000 -> "1.5M", 350000 -> "350K")
 */
function formatCredits(val) {
    if (val >= 1000000) {
        const m = val / 1000000;
        return (m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)) + 'M';
    }
    if (val >= 1000) {
        const k = val / 1000;
        return (k % 1 === 0 ? k.toFixed(0) : k.toFixed(0)) + 'K';
    }
    return Math.round(val).toString();
}

/**
 * LTTB downsampling — picks the point per bucket that forms the largest
 * triangle with the previously selected point and the next bucket's average.
 * Preserves peaks and visual shape far better than simple averaging.
 */
function _lttb(data, target) {
    const len = data.length;
    if (target >= len || target < 3) return data.slice();

    const result = [];
    // Always keep first point
    result.push(data[0]);

    const bucketSize = (len - 2) / (target - 2);

    let prevSelected = 0;
    for (let i = 0; i < target - 2; i++) {
        const bucketStart = Math.floor((i) * bucketSize) + 1;
        const bucketEnd = Math.floor((i + 1) * bucketSize) + 1;

        // Compute average of next bucket (for triangle endpoint)
        const nextStart = Math.floor((i + 1) * bucketSize) + 1;
        const nextEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, len);
        let avgT = 0, avgV = 0;
        const nextCount = nextEnd - nextStart;
        for (let j = nextStart; j < nextEnd; j++) {
            avgT += data[j].t;
            avgV += data[j].v;
        }
        avgT /= nextCount;
        avgV /= nextCount;

        // Find point in current bucket with largest triangle area
        const pT = data[prevSelected].t;
        const pV = data[prevSelected].v;
        let maxArea = -1;
        let bestIdx = bucketStart;
        for (let j = bucketStart; j < bucketEnd; j++) {
            const area = Math.abs(
                (pT - avgT) * (data[j].v - pV) -
                (pT - data[j].t) * (avgV - pV)
            );
            if (area > maxArea) {
                maxArea = area;
                bestIdx = j;
            }
        }

        result.push(data[bestIdx]);
        prevSelected = bestIdx;
    }

    // Always keep last point
    result.push(data[len - 1]);
    return result;
}

/**
 * Read history data from the JSONL log file, returning raw credits.
 * @param {number} windowMs - time window in milliseconds
 * @param {string} field - field name to extract ('5h' or '7d')
 * @param {number} maxPoints - maximum number of data points to return (downsampled)
 * @returns {{ ok: boolean, points: Array<{t: number, v: number}>, avg: number, peak: number, limit: number, error?: string }}
 */
function readHistory(windowMs, field, maxPoints, bucketMs, rateBucketMs) {
    const path = _getLogPath();
    const file = Gio.File.new_for_path(path);

    if (!file.query_exists(null)) {
        return { ok: false, points: [], avg: 0, peak: 0, limit: 0, error: 'no-file' };
    }

    let contents;
    try {
        const [success, bytes] = file.load_contents(null);
        if (!success) {
            return { ok: false, points: [], avg: 0, peak: 0, limit: 0, error: 'read-failed' };
        }
        contents = imports.byteArray.toString(bytes);
    } catch (e) {
        return { ok: false, points: [], avg: 0, peak: 0, limit: 0, error: 'read-failed' };
    }

    const nowMs = Date.now();
    const cutoff = nowMs - windowMs;
    const lines = contents.split('\n');
    const filtered = [];
    let lastTier = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        let entry;
        try {
            entry = JSON.parse(line);
        } catch (e) {
            continue;
        }

        if (!entry.ts) continue;
        const tMs = new Date(entry.ts).getTime();
        if (isNaN(tMs) || tMs < cutoff) continue;

        const pct = entry[field];
        if (pct == null || typeof pct !== 'number') continue;

        const tier = entry.tier || null;
        const limits = _getLimits(tier);
        const credits = (pct / 100) * limits[field];

        filtered.push({ t: tMs, v: credits });
        lastTier = tier;
    }

    if (filtered.length < 2) {
        return { ok: true, points: [], total: 0, avgRate: 0, peakRate: 0 };
    }

    // Sort by time
    filtered.sort((a, b) => a.t - b.t);

    // Compute instantaneous deltas (raw credits consumed between samples)
    const deltas = [];
    for (let i = 1; i < filtered.length; i++) {
        const prev = filtered[i - 1].v;
        const curr = filtered[i].v;
        // If current >= previous, normal consumption within same window
        // If current < previous, window reset — new credits since reset
        const delta = curr >= prev ? curr - prev : curr;
        deltas.push({ t: filtered[i].t, v: delta });
    }

    // Compute total
    let total = 0;
    for (let i = 0; i < deltas.length; i++) {
        total += deltas[i].v;
    }
    total = Math.round(total);

    // Compute rate stats (avg and peak per rateBucket)
    const numBuckets = Math.max(1, Math.floor(windowMs / rateBucketMs));
    const avgRate = Math.round(total / numBuckets);

    // Peak rate: find the bucket with the highest sum
    let peakRate = 0;
    const tStart = cutoff;
    for (let i = 0; i < numBuckets; i++) {
        const bStart = tStart + i * rateBucketMs;
        const bEnd = bStart + rateBucketMs;
        let bSum = 0;
        for (let j = 0; j < deltas.length; j++) {
            if (deltas[j].t >= bStart && deltas[j].t < bEnd) {
                bSum += deltas[j].v;
            }
        }
        if (bSum > peakRate) peakRate = bSum;
    }
    peakRate = Math.round(peakRate);

    // Downsample
    let points;
    let alignedStart = cutoff;
    let alignedEnd = nowMs;

    if (bucketMs > 0) {
        // Align start to clock boundary (floor to bucketMs in local time)
        if (bucketMs >= 86400000) {
            // Day-level: align to midnight
            const d = new Date(cutoff);
            d.setHours(0, 0, 0, 0);
            alignedStart = d.getTime();
        } else {
            // Sub-day: align to bucket boundary within the day
            const d = new Date(cutoff);
            const dayStart = new Date(d);
            dayStart.setHours(0, 0, 0, 0);
            const msIntoDay = d.getTime() - dayStart.getTime();
            const alignedMs = Math.floor(msIntoDay / bucketMs) * bucketMs;
            alignedStart = dayStart.getTime() + alignedMs;
        }
        alignedEnd = nowMs;

        points = [];
        let bStart = alignedStart;
        while (bStart < nowMs) {
            const bEnd = Math.min(bStart + bucketMs, nowMs);
            const actualDur = bEnd - bStart;
            let bSum = 0;
            for (let j = 0; j < deltas.length; j++) {
                if (deltas[j].t >= bStart && deltas[j].t < bEnd) {
                    bSum += deltas[j].v;
                }
            }
            // Scale partial buckets to full-bucket rate
            const scaled = actualDur < bucketMs ? bSum * (bucketMs / actualDur) : bSum;
            points.push({ t: bStart, v: scaled, dur: actualDur });
            bStart = bStart + bucketMs;
        }
    } else if (deltas.length > maxPoints) {
        // LTTB (Largest Triangle Three Buckets)
        points = _lttb(deltas, maxPoints);
    } else {
        points = deltas;
    }

    return { ok: true, points, total, avgRate, peakRate, windowStart: alignedStart, windowEnd: alignedEnd };
}

/**
 * Read history data for a fixed time range (calendar-aligned periods).
 * @param {number} startMs - start of range in ms
 * @param {number} endMs - end of range in ms
 * @param {string} field - '5h' or '7d'
 * @param {number} bucketMs - bucket size for bar chart
 * @param {number} rateBucketMs - bucket size for rate stats
 * @returns {{ ok: boolean, points: Array<{t: number, v: number}>, total: number, avgRate: number, peakRate: number, windowStart: number, windowEnd: number }}
 */
function readHistoryRange(startMs, endMs, field, bucketMs, rateBucketMs) {
    const path = _getLogPath();
    const file = Gio.File.new_for_path(path);

    if (!file.query_exists(null)) {
        return { ok: false, points: [], total: 0, avgRate: 0, peakRate: 0, error: 'no-file' };
    }

    let contents;
    try {
        const [success, bytes] = file.load_contents(null);
        if (!success) {
            return { ok: false, points: [], total: 0, avgRate: 0, peakRate: 0, error: 'read-failed' };
        }
        contents = imports.byteArray.toString(bytes);
    } catch (e) {
        return { ok: false, points: [], total: 0, avgRate: 0, peakRate: 0, error: 'read-failed' };
    }

    const lines = contents.split('\n');
    const filtered = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        let entry;
        try {
            entry = JSON.parse(line);
        } catch (e) {
            continue;
        }

        if (!entry.ts) continue;
        const tMs = new Date(entry.ts).getTime();
        if (isNaN(tMs) || tMs < startMs || tMs > endMs) continue;

        const pct = entry[field];
        if (pct == null || typeof pct !== 'number') continue;

        const tier = entry.tier || null;
        const limits = _getLimits(tier);
        const credits = (pct / 100) * limits[field];

        filtered.push({ t: tMs, v: credits });
    }

    if (filtered.length < 2) {
        return { ok: true, points: [], total: 0, avgRate: 0, peakRate: 0, windowStart: startMs, windowEnd: endMs };
    }

    filtered.sort((a, b) => a.t - b.t);

    // Compute deltas
    const deltas = [];
    for (let i = 1; i < filtered.length; i++) {
        const prev = filtered[i - 1].v;
        const curr = filtered[i].v;
        const delta = curr >= prev ? curr - prev : curr;
        deltas.push({ t: filtered[i].t, v: delta });
    }

    // Total
    let total = 0;
    for (let i = 0; i < deltas.length; i++) {
        total += deltas[i].v;
    }
    total = Math.round(total);

    // Rate stats
    const windowMs = endMs - startMs;
    const numBuckets = Math.max(1, Math.floor(windowMs / rateBucketMs));
    const avgRate = Math.round(total / numBuckets);

    let peakRate = 0;
    for (let i = 0; i < numBuckets; i++) {
        const bStart = startMs + i * rateBucketMs;
        const bEnd = bStart + rateBucketMs;
        let bSum = 0;
        for (let j = 0; j < deltas.length; j++) {
            if (deltas[j].t >= bStart && deltas[j].t < bEnd) {
                bSum += deltas[j].v;
            }
        }
        if (bSum > peakRate) peakRate = bSum;
    }
    peakRate = Math.round(peakRate);

    // Bucket into bars (no partial-bucket scaling for historical periods)
    const points = [];
    if (bucketMs > 0) {
        let bStart = startMs;
        while (bStart < endMs) {
            const bEnd = bStart + bucketMs;
            let bSum = 0;
            for (let j = 0; j < deltas.length; j++) {
                if (deltas[j].t >= bStart && deltas[j].t < bEnd) {
                    bSum += deltas[j].v;
                }
            }
            points.push({ t: bStart, v: bSum, dur: bucketMs });
            bStart += bucketMs;
        }
    }

    return { ok: true, points, total, avgRate, peakRate, windowStart: startMs, windowEnd: endMs };
}
