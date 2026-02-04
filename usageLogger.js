'use strict';

const { Gio, GLib } = imports.gi;

const LOG_INTERVAL_S = 300; // 5 minutes
const LOG_DIR_NAME = 'claude-usage';
const LOG_FILE_NAME = 'history.jsonl';

let _lastLogTime = 0;

function _getLogPath() {
    const dataDir = GLib.get_user_data_dir(); // ~/.local/share
    return GLib.build_filenamev([dataDir, LOG_DIR_NAME, LOG_FILE_NAME]);
}

function _ensureLogDir() {
    const dataDir = GLib.get_user_data_dir();
    const dirPath = GLib.build_filenamev([dataDir, LOG_DIR_NAME]);
    const dir = Gio.File.new_for_path(dirPath);
    if (!dir.query_exists(null)) {
        dir.make_directory_with_parents(null);
    }
}

/**
 * Log usage data if at least LOG_INTERVAL_S has passed since the last log.
 * @param {object} data - API response data
 * @param {object} cred - Credential info with plan and tier
 */
function maybeLog(data, cred) {
    const now = GLib.get_monotonic_time() / 1000000; // microseconds to seconds
    if (now - _lastLogTime < LOG_INTERVAL_S) {
        return;
    }

    try {
        _ensureLogDir();

        const entry = {
            ts: new Date().toISOString(),
            plan: cred.plan || null,
            tier: cred.tier || null,
        };

        if (data.five_hour) {
            entry['5h'] = data.five_hour.utilization;
            if (data.five_hour.resets_at) entry['5h_resets'] = data.five_hour.resets_at;
        }
        if (data.seven_day) {
            entry['7d'] = data.seven_day.utilization;
            if (data.seven_day.resets_at) entry['7d_resets'] = data.seven_day.resets_at;
        }
        if (data.seven_day_sonnet && data.seven_day_sonnet.utilization != null) {
            entry['sonnet_7d'] = data.seven_day_sonnet.utilization;
        }
        if (data.seven_day_opus && data.seven_day_opus.utilization != null) {
            entry['opus_7d'] = data.seven_day_opus.utilization;
        }
        if (data.seven_day_cowork && data.seven_day_cowork.utilization != null) {
            entry['cowork_7d'] = data.seven_day_cowork.utilization;
        }

        const line = JSON.stringify(entry) + '\n';
        const path = _getLogPath();
        const file = Gio.File.new_for_path(path);
        const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        stream.write_all(line, null);
        stream.close(null);

        _lastLogTime = now;
    } catch (e) {
        log('claude-usage: failed to write log: ' + e.message);
    }
}

function reset() {
    _lastLogTime = 0;
}
