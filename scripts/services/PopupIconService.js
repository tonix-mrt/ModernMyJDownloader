'use strict';

angular.module('myjdWebextensionApp')
    .service('PopupIconService', [
        function () {
            this.updateBadge = function (attributes) {
                var actionApi = chrome.action || chrome.browserAction;
                if (!actionApi) return;
                if (attributes.color !== undefined) {
                    actionApi.setBadgeBackgroundColor({color: attributes.color});
                }
                if (attributes.text !== undefined) {
                    actionApi.setBadgeText({text: attributes.text});
                }
            };
        }]);
