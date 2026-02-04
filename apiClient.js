'use strict';

const { Soup, GLib } = imports.gi;

const API_URL = 'https://api.anthropic.com/api/oauth/usage';

let _session = null;

function _getSession() {
    if (!_session) {
        _session = new Soup.SessionAsync();
        Soup.Session.prototype.add_feature.call(_session, new Soup.ProxyResolverDefault());
    }
    return _session;
}

/**
 * Fetches usage data from the Anthropic OAuth API.
 * callback(error, data) — error is null on success.
 *
 * Returns the Soup.Message so callers can cancel via session.cancel_message().
 */
function fetchUsage(token, callback) {
    const session = _getSession();
    const message = Soup.Message.new('GET', API_URL);

    message.request_headers.append('Authorization', 'Bearer ' + token);
    message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

    session.queue_message(message, function (_session, msg) {
        if (msg.status_code !== 200) {
            if (msg.status_code === 401 || msg.status_code === 403) {
                callback('auth-error', null);
            } else if (msg.status_code === 0 || msg.status_code === 2) {
                // Cancelled
                callback('cancelled', null);
            } else {
                callback('http-' + msg.status_code, null);
            }
            return;
        }

        try {
            const body = msg.response_body.data;
            const data = JSON.parse(body);
            callback(null, data);
        } catch (e) {
            callback('parse-error', null);
        }
    });

    return message;
}

/**
 * Cancel a pending message.
 */
function cancelMessage(message) {
    if (_session && message) {
        _session.cancel_message(message, Soup.Status.CANCELLED);
    }
}

/**
 * Fetches service status from the Claude status page API.
 * callback(error, data) — error is null on success.
 *
 * Returns the Soup.Message so callers can cancel via session.cancel_message().
 */
function fetchStatus(callback) {
    const session = _getSession();
    const message = Soup.Message.new('GET', 'https://status.claude.com/api/v2/summary.json');

    session.queue_message(message, function (_session, msg) {
        if (msg.status_code !== 200) {
            if (msg.status_code === 0 || msg.status_code === 2) {
                callback('cancelled', null);
            } else {
                callback('http-' + msg.status_code, null);
            }
            return;
        }

        try {
            const body = msg.response_body.data;
            const data = JSON.parse(body);
            callback(null, data);
        } catch (e) {
            callback('parse-error', null);
        }
    });

    return message;
}

function destroySession() {
    if (_session) {
        _session.abort();
        _session = null;
    }
}
