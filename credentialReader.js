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
            refreshToken: oauth.refreshToken || null,
            expiresAt: oauth.expiresAt || null,
            plan: oauth.subscriptionType || null,
            tier: oauth.rateLimitTier || null,
        };
    } catch (e) {
        return { ok: false, error: 'parse-error' };
    }
}

/**
 * Writes updated OAuth tokens back to ~/.claude/.credentials.json
 * Preserves all existing fields (scopes, subscriptionType, rateLimitTier, etc.)
 * Returns { ok: true } or { ok: false, error: 'write-failed' }
 */
function writeToken(accessToken, refreshToken, expiresAt) {
    const path = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
    const file = Gio.File.new_for_path(path);

    try {
        const [success, contents] = file.load_contents(null);
        if (!success) {
            return { ok: false, error: 'write-failed' };
        }

        const text = imports.byteArray.toString(contents);
        const data = JSON.parse(text);

        if (!data.claudeAiOauth) {
            return { ok: false, error: 'write-failed' };
        }

        data.claudeAiOauth.accessToken = accessToken;
        data.claudeAiOauth.refreshToken = refreshToken;
        data.claudeAiOauth.expiresAt = expiresAt;

        const newContents = JSON.stringify(data, null, 2) + '\n';
        const bytes = new GLib.Bytes(newContents);
        const [ok] = file.replace_contents(bytes.get_data(), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);

        return ok ? { ok: true } : { ok: false, error: 'write-failed' };
    } catch (e) {
        return { ok: false, error: 'write-failed' };
    }
}
