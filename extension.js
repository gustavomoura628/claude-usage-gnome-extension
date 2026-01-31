'use strict';

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

let _indicator = null;

function init() {
    // Nothing to do at init time
}

function enable() {
    const { ClaudeUsageIndicator } = Me.imports.indicator;
    _indicator = new ClaudeUsageIndicator();
}

function disable() {
    if (_indicator) {
        _indicator.destroy();
        _indicator = null;
    }

    const ApiClient = Me.imports.apiClient;
    ApiClient.destroySession();
}
