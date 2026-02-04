'use strict';

const { Gio, GLib } = imports.gi;

/**
 * Reads the OAuth access token from ~/.claude/.credentials.json
 * Returns { ok: true, token } or { ok: false, error }
 */
function readToken() {
    const path = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
    const file = Gio.File.new_for_path(path);

    if (!file.query_exists(null)) {
        return { ok: false, error: 'no-credentials' };
    }

    try {
        const [success, contents] = file.load_contents(null);
        if (!success) {
            return { ok: false, error: 'read-failed' };
        }

        const text = imports.byteArray.toString(contents);
        const data = JSON.parse(text);
        const oauth = data.claudeAiOauth;
        const token = oauth && oauth.accessToken;

        if (!token) {
            return { ok: false, error: 'no-token' };
        }

        return {
            ok: true,
            token: token,
            plan: oauth.subscriptionType || null,
            tier: oauth.rateLimitTier || null,
        };
    } catch (e) {
        return { ok: false, error: 'parse-error' };
    }
}
