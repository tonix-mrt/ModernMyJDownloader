'use strict';

/**
 * MyJDownloader Browser Extension - Manifest V3 Background Service Worker
 */

importScripts(
  'vendor/crypto-js/components/core.js',
  'vendor/crypto-js/rollups/aes.js',
  'vendor/crypto-js/rollups/hmac-sha256.js',
  'scripts/background/jdapi-sw.js'
);

const BUILD_VERSION = chrome.runtime.getManifest().version;

const ITEM_TYPE = {
  TEXT: 'text',
  LINK: 'link',
  CNL: 'cnl'
};

const STORAGE_KEYS = {
  CLIPBOARD_OBSERVER: 'CLIPBOARD_OBSERVER',
  CONTEXT_MENU_SIMPLE: 'CONTEXT_MENU_SIMPLE',
  ENHANCE_CAPTCHA_DIALOG: 'ENHANCE_CAPTCHA_DIALOG',
  CAPTCHA_PRIVACY_MODE: 'CAPTCHA_PRIVACY_MODE',
  CLICKNLOAD_ACTIVE: 'CLICKNLOAD_ACTIVE'
};

const SESSION_KEYS = {
  REQUEST_QUEUE: 'MYJD_SESSION_REQUEST_QUEUE',
  RC2_TABS: 'MYJD_SESSION_RC2_TABS',
  POPUP_CANDIDATES: 'MYJD_SESSION_POPUP_CANDIDATES'
};

const DNR_CNL_RULE_IDS = [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008];

const JD_CHECK_TRUE_RESPONSE_DATA_URI =
  'data:text/javascript;charset=utf-8;base64,dmFyIGpkb3dubG9hZGVyID0gdHJ1ZTs=';
const JD_CHECK_CROSS_DOMAIN_DATA_URI =
  'data:text/xml;charset=utf-8;base64,PD94bWwgdmVyc2lvbj0iMS4wIiA/Pg0KPGNyb3NzLWRvbWFpbi1wb2xpY3k+DQogIDxzaXRlLWNvbnRyb2wgcGVybWl0dGVkLWNyb3NzLWRvbWFpbi1wb2xpY2llcz0ibWFzdGVyLW9ubHkiLz4NCiAgPGFsbG93LWFjY2Vzcy1mcm9tIGRvbWFpbj0iKiIvPg0KICA8YWxsb3ctaHR0cC1yZXF1ZXN0LWhlYWRlcnMtZnJvbSBkb21haW49IioiIGhlYWRlcnM9IioiLz4NCjwvY3Jvc3MtZG9tYWluLXBvbGljeT4=';
const JD_CNL_DUMMY_HTML_DATA_URI =
  'data:text/html;charset=utf-8,<html><body>JDownloader%20Click%27n%27Load</body></html>';

const urlRegexp = new RegExp(
  '([a-zA-Z0-9]+://)?([a-zA-Z0-9_]+:[a-zA-Z0-9_]+@)?([a-zA-Z0-9.-]+\\.[A-Za-z]{2,4})(:[0-9]+)?(/.*)?'
);

// Singleton JDAPI Client for Service Worker
const myjdClient = new self.MyJDClientSW({
  API_ROOT: 'https://api.jdownloader.org',
  APP_KEY: 'myjd_webextension_chrome'
});

// State caches (backed by chrome.storage.session / chrome.storage.local)
let requestIDCounter = 0;
let requestQueue = {};
let rc2TabUpdateCallbacks = {};
let rc2CanCloseIntervalHandles = {};
let popupCandidates = {};
let previousActiveTab = null;
let removedTabListeners = {};

let state = {
  isConnected: false,
  clipboardObserver: false
};

let settings = {
  [STORAGE_KEYS.CLIPBOARD_OBSERVER]: false,
  [STORAGE_KEYS.CONTEXT_MENU_SIMPLE]: true,
  [STORAGE_KEYS.ENHANCE_CAPTCHA_DIALOG]: true,
  [STORAGE_KEYS.CAPTCHA_PRIVACY_MODE]: false,
  [STORAGE_KEYS.CLICKNLOAD_ACTIVE]: true
};

let isAllowedIncognito = false;
if (chrome.extension && typeof chrome.extension.isAllowedIncognitoAccess === 'function') {
  chrome.extension.isAllowedIncognitoAccess((allowed) => {
    isAllowedIncognito = Boolean(allowed);
  });
}

// ============================================================================
// Session Storage Persistence Helpers
// ============================================================================
let sessionLoadedPromise = null;

function ensureSessionStateLoaded() {
  if (sessionLoadedPromise) return sessionLoadedPromise;
  sessionLoadedPromise = new Promise((resolve) => {
    if (!chrome.storage || !chrome.storage.session) {
      resolve();
      return;
    }
    chrome.storage.session.get(
      [SESSION_KEYS.REQUEST_QUEUE, SESSION_KEYS.RC2_TABS, SESSION_KEYS.POPUP_CANDIDATES],
      (res) => {
        if (res && res[SESSION_KEYS.REQUEST_QUEUE]) {
          requestQueue = Object.assign({}, res[SESSION_KEYS.REQUEST_QUEUE], requestQueue);
        }
        if (res && res[SESSION_KEYS.RC2_TABS]) {
          for (const [tabId, data] of Object.entries(res[SESSION_KEYS.RC2_TABS])) {
            if (!rc2TabUpdateCallbacks[tabId]) {
              rc2TabUpdateCallbacks[tabId] = data;
            }
          }
        }
        if (res && res[SESSION_KEYS.POPUP_CANDIDATES]) {
          popupCandidates = Object.assign({}, res[SESSION_KEYS.POPUP_CANDIDATES], popupCandidates);
        }
        resolve();
      }
    );
  });
  return sessionLoadedPromise;
}

function saveRequestQueue() {
  if (chrome.storage && chrome.storage.session) {
    chrome.storage.session.set({ [SESSION_KEYS.REQUEST_QUEUE]: requestQueue });
  }
}

function saveRc2Tabs() {
  if (chrome.storage && chrome.storage.session) {
    const serializable = {};
    for (const [k, v] of Object.entries(rc2TabUpdateCallbacks)) {
      if (v && v.captchaParams) {
        serializable[k] = { captchaParams: v.captchaParams, needsInject: Boolean(v.callback) };
      }
    }
    chrome.storage.session.set({ [SESSION_KEYS.RC2_TABS]: serializable });
  }
}

function savePopupCandidates() {
  if (chrome.storage && chrome.storage.session) {
    chrome.storage.session.set({ [SESSION_KEYS.POPUP_CANDIDATES]: popupCandidates });
  }
}

function queueContains(request, tabId) {
  const list = requestQueue[tabId];
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.some(
    (value) =>
      request.type !== undefined &&
      request.type === value.type &&
      request.type === ITEM_TYPE.LINK &&
      request.content !== undefined &&
      request.content === value.content
  );
}

// ============================================================================
// Error & Formatting Helpers
// ============================================================================
function chromeErrorCallback() {
  if (chrome.runtime && chrome.runtime.lastError && chrome.runtime.lastError.message) {
    // Suppress benign MV3 messaging errors when tabs/popups close
  }
}

function safeSendMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      if (chrome.runtime.lastError) {
        // Ignore when no UI view is open to receive broadcast
      }
    });
  } catch (e) {}
}

function safeTabSendMessage(tabId, message, callback) {
  if (tabId === undefined || tabId === null || tabId < 0) return;
  try {
    chrome.tabs.sendMessage(Number(tabId), message, (res) => {
      if (chrome.runtime.lastError) {
        // Ignore if content script not ready in tab
      }
      if (typeof callback === 'function') callback(res);
    });
  } catch (e) {}
}

function updateBadge(currentState) {
  const popupAttr = { text: '' };
  if (!currentState.isConnected) {
    popupAttr.text = '!';
    popupAttr.color = '#f3d435';
  }
  if (currentState.clipboardObserver === true && currentState.isConnected) {
    popupAttr.text = 'Clip';
    popupAttr.color = '#368a8f';
  }
  if (popupAttr.color !== undefined) {
    chrome.action.setBadgeBackgroundColor({ color: popupAttr.color }, chromeErrorCallback);
  }
  if (popupAttr.text !== undefined) {
    chrome.action.setBadgeText({ text: popupAttr.text }, chromeErrorCallback);
  }
}

// ============================================================================
// Settings Initialization
// ============================================================================
function initSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [
        STORAGE_KEYS.CLIPBOARD_OBSERVER,
        STORAGE_KEYS.CONTEXT_MENU_SIMPLE,
        STORAGE_KEYS.ENHANCE_CAPTCHA_DIALOG,
        STORAGE_KEYS.CAPTCHA_PRIVACY_MODE,
        STORAGE_KEYS.CLICKNLOAD_ACTIVE
      ],
      (result) => {
        const res = result || {};
        settings[STORAGE_KEYS.CLIPBOARD_OBSERVER] =
          res[STORAGE_KEYS.CLIPBOARD_OBSERVER] !== undefined
            ? res[STORAGE_KEYS.CLIPBOARD_OBSERVER]
            : false;
        state.clipboardObserver = settings[STORAGE_KEYS.CLIPBOARD_OBSERVER];

        settings[STORAGE_KEYS.CONTEXT_MENU_SIMPLE] =
          res[STORAGE_KEYS.CONTEXT_MENU_SIMPLE] !== undefined
            ? res[STORAGE_KEYS.CONTEXT_MENU_SIMPLE]
            : true;

        settings[STORAGE_KEYS.ENHANCE_CAPTCHA_DIALOG] =
          res[STORAGE_KEYS.ENHANCE_CAPTCHA_DIALOG] !== undefined
            ? res[STORAGE_KEYS.ENHANCE_CAPTCHA_DIALOG]
            : true;

        settings[STORAGE_KEYS.CAPTCHA_PRIVACY_MODE] =
          res[STORAGE_KEYS.CAPTCHA_PRIVACY_MODE] !== undefined
            ? res[STORAGE_KEYS.CAPTCHA_PRIVACY_MODE]
            : false;

        settings[STORAGE_KEYS.CLICKNLOAD_ACTIVE] =
          res[STORAGE_KEYS.CLICKNLOAD_ACTIVE] !== undefined
            ? res[STORAGE_KEYS.CLICKNLOAD_ACTIVE]
            : true;

        resolve(settings);
      }
    );
  });
}

// ============================================================================
// DeclarativeNetRequest Rules (Replaces MV2 blocking webRequest)
// ============================================================================
let dnrUpdateChain = Promise.resolve();

function syncCnlDeclarativeRules(enable) {
  if (!chrome.declarativeNetRequest) return Promise.resolve();

  dnrUpdateChain = dnrUpdateChain
    .then(async () => {
      if (!enable) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: DNR_CNL_RULE_IDS,
          addRules: []
        });
        return;
      }

      const rules = [
        {
          id: 1001,
          priority: 100,
          action: {
            type: 'redirect',
            redirect: { url: JD_CHECK_TRUE_RESPONSE_DATA_URI }
          },
          condition: {
            urlFilter: 'http://127.0.0.1:9666/jdcheck.js*',
            resourceTypes: ['script', 'xmlhttprequest', 'other']
          }
        },
        {
          id: 1002,
          priority: 100,
          action: {
            type: 'redirect',
            redirect: { url: JD_CHECK_TRUE_RESPONSE_DATA_URI }
          },
          condition: {
            urlFilter: 'http://localhost:9666/jdcheck.js*',
            resourceTypes: ['script', 'xmlhttprequest', 'other']
          }
        },
        {
          id: 1003,
          priority: 100,
          action: {
            type: 'redirect',
            redirect: { url: JD_CHECK_CROSS_DOMAIN_DATA_URI }
          },
          condition: {
            urlFilter: 'http://127.0.0.1:9666/crossdomain.xml*',
            resourceTypes: ['xmlhttprequest', 'other', 'sub_frame', 'main_frame']
          }
        },
        {
          id: 1004,
          priority: 100,
          action: {
            type: 'redirect',
            redirect: { url: JD_CHECK_CROSS_DOMAIN_DATA_URI }
          },
          condition: {
            urlFilter: 'http://localhost:9666/crossdomain.xml*',
            resourceTypes: ['xmlhttprequest', 'other', 'sub_frame', 'main_frame']
          }
        },
        {
          id: 1005,
          priority: 90,
          action: {
            type: 'redirect',
            redirect: { url: JD_CNL_DUMMY_HTML_DATA_URI }
          },
          condition: {
            urlFilter: 'http://127.0.0.1:9666/flash/add*',
            resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'ping', 'other']
          }
        },
        {
          id: 1006,
          priority: 90,
          action: {
            type: 'redirect',
            redirect: { url: JD_CNL_DUMMY_HTML_DATA_URI }
          },
          condition: {
            urlFilter: 'http://localhost:9666/flash/add*',
            resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'ping', 'other']
          }
        },
        {
          id: 1007,
          priority: 110,
          action: {
            type: 'allow'
          },
          condition: {
            urlFilter: 'http://127.0.0.1:9666/flash/add*fromExtension*',
            resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'ping', 'other']
          }
        },
        {
          id: 1008,
          priority: 110,
          action: {
            type: 'allow'
          },
          condition: {
            urlFilter: 'http://localhost:9666/flash/add*fromExtension*',
            resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'ping', 'other']
          }
        }
      ];

      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: DNR_CNL_RULE_IDS,
        addRules: rules
      });
    })
    .catch((e) => {
      console.warn('[MyJD MV3] Failed to update DNR rules:', e);
    });

  return dnrUpdateChain;
}

async function addCaptchaTabCspRule(tabId) {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
  const ruleId = 2000 + (Number(tabId) % 10000);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 200,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [
              { header: 'content-security-policy', operation: 'remove' },
              { header: 'content-security-policy-report-only', operation: 'remove' },
              { header: 'x-frame-options', operation: 'remove' }
            ]
          },
          condition: {
            tabIds: [Number(tabId)],
            resourceTypes: ['main_frame', 'sub_frame']
          }
        }
      ]
    });
  } catch (e) {}
}

async function removeCaptchaTabCspRule(tabId) {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
  const ruleId = 2000 + (Number(tabId) % 10000);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: []
    });
  } catch (e) {}
}

// ============================================================================
// Click'n'Load Helpers & Interception
// ============================================================================
function checkIfRequestMatches(testRequest, path) {
  return (
    testRequest.indexOf('localhost:9666' + path) !== -1 ||
    testRequest.indexOf('127.0.0.1:9666' + path) !== -1
  );
}

function isJDCheckUrl(url) {
  return checkIfRequestMatches(url, '/jdcheck.js') || url.endsWith('/jdcheck.js');
}

function isFlashAddCryptedUrl(url) {
  return checkIfRequestMatches(url, '/flash/addcrypted2');
}

function isFlashAddUrl(url) {
  return checkIfRequestMatches(url, '/flash/add');
}

function parseRawPostBody(body) {
  const result = {};
  if (!body) return result;
  const vars = body.split('&');
  for (let i = 0; i < vars.length; i++) {
    const pair = vars[i].split('=');
    const key = pair[0];
    const rawVal = pair.slice(1).join('=');
    const val = decodeURIComponent((rawVal || '').replace(/\+/g, ' '));
    if (result[key] === undefined) {
      result[key] = val;
    } else if (typeof result[key] === 'string') {
      result[key] = [result[key], val];
    } else {
      result[key].push(val);
    }
  }
  return result;
}

function readArrayBuffer(buffers) {
  const decoder = new TextDecoder('utf-8');
  let output = '';
  for (let j = 0; j < buffers.length; j++) {
    if (buffers[j] && buffers[j].bytes) {
      output += decoder.decode(new Uint8Array(buffers[j].bytes), { stream: true });
    }
  }
  output += decoder.decode();
  return output;
}

function addCNLRequestToQueue(tab, details, openerTab) {
  requestIDCounter++;
  const time = Date.now();
  const detailsTab = openerTab || tab || { id: details.tabId };

  if (!details.requestBody) {
    details.requestBody = { formData: {} };
  }
  if (
    details.requestBody.raw &&
    details.requestBody.raw[0] &&
    details.requestBody.raw[0].bytes &&
    !details.requestBody.formData
  ) {
    try {
      const rawPostBody = readArrayBuffer(details.requestBody.raw);
      details.requestBody.formData = parseRawPostBody(rawPostBody);
    } catch (e) {
      details.requestBody.formData = {};
    }
  }

  const formData = (details.requestBody && details.requestBody.formData) || {};
  details.source = Array.isArray(formData.source) ? formData.source[0] : formData.source;
  details.urls = formData.urls;
  details.passwords = formData.passwords;
  details.package = Array.isArray(formData.package) ? formData.package[0] : formData.package;

  // Serialize clean copy without raw ArrayBuffers so chrome.storage.session can store it
  const sanitizedDetails = {
    url: details.url,
    tabId: details.tabId,
    type: details.type,
    source: details.source,
    urls: details.urls,
    passwords: details.passwords,
    package: details.package,
    requestBody: {
      formData: formData
    }
  };

  let parentUrl;
  if (detailsTab.url && detailsTab.url.indexOf('chrome://newtab') === -1) {
    parentUrl = detailsTab.url;
  }
  if (!parentUrl && details.source) {
    parentUrl = details.source;
  }

  let faviconUrl = detailsTab.favIconUrl;
  if (!faviconUrl && details.source && urlRegexp.test(details.source)) {
    faviconUrl =
      (details.source.startsWith('http://') || details.source.startsWith('https://')
        ? details.source
        : 'https://' + details.source) + '/favicon.ico';
  }

  let title = detailsTab.title;
  if (!title && details.package) {
    title = details.package;
  }

  const newRequest = {
    id: '' + requestIDCounter + time + Math.random() * 10000,
    type: ITEM_TYPE.CNL,
    time: time,
    parent: {
      url: parentUrl,
      title: title,
      favIconUrl: faviconUrl
    },
    content: sanitizedDetails
  };

  const targetTabId = detailsTab.id;
  if (requestQueue[targetTabId]) {
    requestQueue[targetTabId].push(newRequest);
  } else {
    requestQueue[targetTabId] = [newRequest];
  }
  saveRequestQueue();
}

function toggleToolbar(sender) {
  if (!isNaN(parseFloat(sender))) {
    const tabid = parseFloat(sender);
    safeTabSendMessage(tabid, { action: 'open-in-page-toolbar', tabId: tabid });
    safeTabSendMessage(tabid, { action: 'link-info-update', tabId: tabid });
  } else if (sender === 'close-in-page-toolbar') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (tabs && tabs.length > 0) {
        safeTabSendMessage(tabs[0].id, { action: 'close-in-page-toolbar', tabId: sender });
      }
    });
  } else if (sender === 'open-in-page-toolbar') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (tabs && tabs.length > 0) {
        safeTabSendMessage(tabs[0].id, { action: 'open-in-page-toolbar', tabId: tabs[0].id });
        safeTabSendMessage(tabs[0].id, { action: 'link-info-update', tabId: tabs[0].id });
      }
    });
  }
}

function replaceWithCnlPopup(requestDetails) {
  const isOpera = navigator.userAgent.indexOf(' OPR/') >= 0;
  const options = {
    width: 420,
    height: 384
  };
  if (!isOpera) {
    options.type = 'popup';
  }
  chrome.windows.create(options, (win) => {
    if (!win) return;
    setTimeout(() => {
      chrome.windows.update(
        win.id,
        {
          width: win.width,
          height: (win.height || 384) + 1
        },
        chromeErrorCallback
      );
    }, 800);

    chrome.tabs.query({ windowId: win.id }, (tabs) => {
      if (!tabs || tabs.length === 0 || !tabs[0]) {
        chrome.tabs.create({ windowId: win.id }, (tab) => {
          chrome.tabs.update(
            tab.id,
            { url: chrome.runtime.getURL('toolbar.html?id=' + tab.id + '&popup=true') },
            () => {
              requestDetails.tabId = tab.id;
              addCNLRequestToQueue(tab, requestDetails);
              toggleToolbar(tab.id);
            }
          );
        });
      } else {
        const tab = tabs[0];
        chrome.tabs.update(
          tab.id,
          { url: chrome.runtime.getURL('toolbar.html?id=' + tab.id + '&popup=true') },
          () => {
            requestDetails.tabId = tab.id;
            addCNLRequestToQueue(tab, requestDetails);
            toggleToolbar(tab.id);
          }
        );
      }
    });
  });
}

function checkIfPopup(tab, timestampFirstCnlRequest) {
  if (!tab) return Promise.resolve(false);
  const candidate = popupCandidates[tab.id];
  const lastActiveTab = candidate ? candidate.lastActiveTab : null;
  const lastTabWidth = lastActiveTab != null ? lastActiveTab.width : -1;
  const lastTabHeight = lastActiveTab != null ? lastActiveTab.height : -1;
  const currentTabWidth = tab.width || -1;
  const currentTabHeight = tab.height || -1;
  const smallerThanPreviousTab =
    lastTabWidth + 100 > currentTabWidth && lastTabHeight + 100 > currentTabHeight;
  if (
    smallerThanPreviousTab ||
    (candidate && timestampFirstCnlRequest - candidate.creationTime < 10000)
  ) {
    return Promise.resolve(true);
  }
  return Promise.resolve(false);
}

function handleCnlNewTab(tab, requestDetails) {
  try {
    chrome.tabs.remove(tab.id, chromeErrorCallback);
  } catch (e) {}

  if (tab && tab.openerTabId) {
    chrome.tabs.get(tab.openerTabId, (openerTab) => {
      if (openerTab) {
        addCNLRequestToQueue(openerTab, requestDetails);
        toggleToolbar(openerTab.id);
      }
    });
  } else {
    try {
      chrome.tabs.remove(requestDetails.tabId, chromeErrorCallback);
    } catch (e) {}
    chrome.tabs.query({}, (tabs) => {
      if (tabs && tabs.length > 0) {
        for (const t of tabs) {
          if (t.active && t.highlighted) {
            requestDetails.tabId = t.id;
            addCNLRequestToQueue(t, requestDetails);
            toggleToolbar(t.id);
            break;
          }
        }
      }
    });
  }
}

function flashAddCrypted(details) {
  if (details.tabId !== -1) {
    chrome.tabs.get(details.tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        replaceWithCnlPopup(details);
        return;
      }
      addCNLRequestToQueue(tab, details);
      toggleToolbar(tab.id);
    });
  }
}

function handleCnlWebRequest(requestDetails) {
  if (!state.isConnected || settings[STORAGE_KEYS.CLICKNLOAD_ACTIVE] === false) {
    return;
  }

  if (isJDCheckUrl(requestDetails.url)) {
    if (requestDetails.tabId !== undefined && requestDetails.tabId >= 0) {
      chrome.scripting
        .executeScript({
          target: { tabId: requestDetails.tabId },
          world: 'MAIN',
          func: () => {
            window.jdownloader = true;
          }
        })
        .catch(() => {});
    }
    return;
  }

  if (
    requestDetails.url.indexOf('127.0.0.1:9666/crossdomain.xml') !== -1 ||
    requestDetails.url.indexOf('localhost:9666/crossdomain.xml') !== -1 ||
    requestDetails.url.indexOf('?fromExtension') !== -1
  ) {
    return;
  }

  if (isFlashAddUrl(requestDetails.url) || isFlashAddCryptedUrl(requestDetails.url)) {
    if (requestDetails.type === 'main_frame') {
      chrome.tabs.get(requestDetails.tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          replaceWithCnlPopup(requestDetails);
          return;
        }
        checkIfPopup(tab, Date.now()).then((isPopup) => {
          if (isPopup) {
            chrome.tabs.remove(tab.id, chromeErrorCallback);
            replaceWithCnlPopup(requestDetails);
          } else {
            handleCnlNewTab(tab, requestDetails);
          }
        });
      });
    } else if (requestDetails.type === 'sub_frame') {
      if (requestDetails.tabId !== undefined && requestDetails.tabId >= 0) {
        chrome.tabs.get(requestDetails.tabId, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            replaceWithCnlPopup(requestDetails);
            return;
          }
          chrome.windows.get(tab.windowId, { populate: true }, (win) => {
            if (win && win.type === 'popup') {
              replaceWithCnlPopup(requestDetails);
            } else {
              checkIfPopup(tab, Date.now()).then((isPopup) => {
                if (isPopup) {
                  replaceWithCnlPopup(requestDetails);
                } else {
                  flashAddCrypted(requestDetails);
                }
              });
            }
          });
        });
      }
    } else {
      flashAddCrypted(requestDetails);
    }
  }
}

// ============================================================================
// RC2 / hCaptcha Browser Solver Logic
// ============================================================================
function executeBrowserSolverScripts(tabId) {
  let attempts = 0;
  const intervalHandle = setInterval(() => {
    attempts++;
    if (attempts > 50) {
      clearInterval(intervalHandle);
      return;
    }
    chrome.tabs.get(tabId, (tabDetails) => {
      if (chrome.runtime.lastError || !tabDetails) {
        clearInterval(intervalHandle);
      } else if (
        tabDetails.url &&
        tabDetails.url.match(/http:\/\/127\.0\.0\.1:\d+\/captcha\/(recaptchav(2|3)|hcaptcha)\/.*\?id=\d+$/gm) !== null
      ) {
        clearInterval(intervalHandle);
        chrome.scripting
          .executeScript({
            target: { tabId: tabId, allFrames: true },
            files: ['contentscripts/browserSolverEnhancer.js']
          })
          .catch(() => {});
      }
    });
  }, 200);
}

function handleRc2Request(request) {
  if (
    request.url &&
    request.url.match(/http:\/\/127\.0\.0\.1:\d+\/captcha\/(recaptchav(2|3)|hcaptcha)\/.*\?id=\d+$/gm) !== null
  ) {
    const isForcedPrivateMode = Boolean(settings[STORAGE_KEYS.CAPTCHA_PRIVACY_MODE]);
    if (isAllowedIncognito && isForcedPrivateMode) {
      chrome.tabs.get(request.tabId, (tab) => {
        if (tab != null && tab.incognito === false) {
          chrome.tabs.remove(tab.id, () => {
            chrome.windows.getAll((windows) => {
              let incognitoWindow = null;
              for (let i = 0; i < windows.length; i++) {
                if (windows[i].incognito === true) {
                  incognitoWindow = windows[i];
                }
              }
              if (incognitoWindow == null) {
                chrome.windows.create({ incognito: true }, (win) => {
                  chrome.tabs.create({ url: request.url, windowId: win.id }, (createdTab) => {
                    if (win.tabs && win.tabs[0] && win.tabs[0].id !== createdTab.id) {
                      chrome.tabs.remove(win.tabs[0].id, chromeErrorCallback);
                    }
                    executeBrowserSolverScripts(createdTab.id);
                  });
                });
              } else {
                chrome.tabs.create({ windowId: incognitoWindow.id, url: request.url }, (createdTab) => {
                  executeBrowserSolverScripts(createdTab.id);
                });
              }
            });
          });
        }
      });
    } else if (request.tabId >= 0) {
      executeBrowserSolverScripts(request.tabId);
    }
  }
}

function onLoginNeeded(tabId) {
  chrome.tabs.update(tabId, { url: chrome.runtime.getURL('loginNeeded.html') }, chromeErrorCallback);
}

function onNewCaptchaAvailable(tabId, callbackUrl, params) {
  if (rc2TabUpdateCallbacks[tabId] == null) {
    const captchaParams = {
      callbackUrl: callbackUrl,
      params: params
    };
    rc2TabUpdateCallbacks[tabId] = Object.create(null);
    rc2TabUpdateCallbacks[tabId].captchaParams = captchaParams;
    rc2TabUpdateCallbacks[tabId].callback = (innerTabId) => {
      chrome.scripting
        .executeScript({
          target: { tabId: innerTabId, allFrames: true },
          files: ['contentscripts/rc2Contentscript.js']
        })
        .then(() => {
          safeTabSendMessage(innerTabId, {
            name: 'myjdrc2',
            action: 'captcha-available'
          });
        })
        .catch(() => {
          safeTabSendMessage(innerTabId, {
            name: 'myjdrc2',
            action: 'captcha-available'
          });
        });
    };
    saveRc2Tabs();
    addCaptchaTabCspRule(tabId);
    chrome.tabs.update(tabId, { url: params.finalUrl + '#rc2jdt' }, chromeErrorCallback);
  }
}

function onWebInterfaceCaptchaJobFound(tabId, captchaData, captchaJob) {
  const params = {
    challengeType: captchaData.challengeType || captchaData.type,
    captchaId: captchaData.id,
    hoster: captchaData.hoster,
    v3action: captchaJob.v3Action,
    siteKey: captchaJob.siteKey,
    siteKeyType: captchaJob.type,
    finalUrl: captchaJob.siteUrl || captchaJob.contextUrl
  };
  onNewCaptchaAvailable(tabId, 'MYJD', params);
}

async function sendRc2SolutionToJd(request, sender) {
  if (
    request.data &&
    request.data.callbackUrl !== undefined &&
    request.data.callbackUrl !== 'undefined' &&
    request.data.callbackUrl !== 'MYJD'
  ) {
    try {
      await fetch(request.data.callbackUrl + '&do=solve&response=' + request.data.token, {
        method: 'GET',
        headers: { 'X-Myjd-Appkey': 'webextension-' + BUILD_VERSION }
      });
      if (sender && sender.tab && sender.tab.id) {
        setTimeout(() => {
          chrome.tabs.remove(sender.tab.id, chromeErrorCallback);
        }, 2000);
      }
    } catch (e) {
      console.error('Failed to send RC2 solution to local JD:', e);
    }
  } else if (request.data && request.data.captchaId && request.data.callbackUrl === 'MYJD') {
    chrome.tabs.query(
      {
        url: ['http://my.jdownloader.org/*', 'https://my.jdownloader.org/*']
      },
      (tabs) => {
        if (tabs && tabs.length > 0) {
          for (let i = 0; i < tabs.length; i++) {
            safeTabSendMessage(tabs[i].id, {
              name: 'response',
              type: 'myjdrc2',
              data: { captchaId: request.data.captchaId, token: request.data.token }
            });
          }
        }
      }
    );
  }
}

function onRc2MouseMove(callbackUrl, timestamp) {
  if (!callbackUrl || callbackUrl === 'MYJD') return;
  fetch(callbackUrl + '&do=canClose&useractive=true&ts=' + timestamp, {
    method: 'GET',
    headers: { 'X-Myjd-Appkey': 'webextension-' + BUILD_VERSION }
  }).catch(() => {});
}

function onRc2FrameLoaded(request) {
  const params = request.params || {};
  const callbackUrl = request.callbackUrl;
  if (!callbackUrl || callbackUrl === 'MYJD') return;
  const urlParams =
    '&x=' + encodeURIComponent(params.x) +
    '&y=' + encodeURIComponent(params.y) +
    '&w=' + encodeURIComponent(params.w) +
    '&h=' + encodeURIComponent(params.h) +
    '&vw=' + encodeURIComponent(params.vw) +
    '&vh=' + encodeURIComponent(params.vh) +
    '&eleft=' + encodeURIComponent(params.eleft) +
    '&etop=' + encodeURIComponent(params.etop) +
    '&ew=' + encodeURIComponent(params.ew) +
    '&eh=' + encodeURIComponent(params.eh) +
    '&dpi=' + encodeURIComponent(params.dpi);

  fetch(callbackUrl + '&do=loaded' + urlParams, {
    method: 'GET',
    headers: { 'X-Myjd-Appkey': 'webextension-' + BUILD_VERSION }
  }).catch(() => {});
}

function removeRc2CanCloseCheck(tabId) {
  if (rc2CanCloseIntervalHandles[tabId] !== undefined) {
    clearInterval(rc2CanCloseIntervalHandles[tabId]);
    delete rc2CanCloseIntervalHandles[tabId];
  }
}

async function checkRc2TabModeCanClose(request, sender) {
  if (!sender || !sender.tab || !sender.tab.id) return;
  const tabId = sender.tab.id;
  try {
    const resp = await fetch(request.data.callbackUrl + '&do=canClose', {
      method: 'GET',
      headers: { 'X-Myjd-Appkey': 'webextension-' + BUILD_VERSION }
    });
    if (resp.ok) {
      const text = await resp.text();
      if (text === 'true') {
        removeRc2CanCloseCheck(tabId);
        chrome.tabs.remove(tabId, chromeErrorCallback);
      }
    }
  } catch (e) {
    removeRc2CanCloseCheck(tabId);
  }
}

async function onSkipRequest(sender, data) {
  if (!data || !data.callbackUrl || data.callbackUrl === 'undefined' || data.callbackUrl === 'MYJD') {
    return;
  }
  let skipUrl = data.callbackUrl + '&do=skip&skiptype=single';
  if (data.skipType === 'all' || data.skipType === 'hoster' || data.skipType === 'package' || data.skipType === 'single') {
    skipUrl = data.callbackUrl + '&do=skip&skiptype=' + data.skipType;
  }
  try {
    await fetch(skipUrl, {
      method: 'GET',
      headers: { 'X-Myjd-Appkey': 'webextension-' + BUILD_VERSION }
    });
    if (sender && sender.tab && sender.tab.id) {
      setTimeout(() => {
        chrome.tabs.remove(sender.tab.id, chromeErrorCallback);
      }, 2000);
    }
  } catch (e) {}
}

function addRemovedTabListener(tabId, listener) {
  if (!removedTabListeners[tabId]) {
    removedTabListeners[tabId] = [];
  }
  if (!removedTabListeners[tabId].includes(listener)) {
    removedTabListeners[tabId].push(listener);
  }
}

// ============================================================================
// Queue & Context Menu Helpers
// ============================================================================
function addPageToRequestQueue(tab) {
  if (!tab || tab.id === undefined) return;
  const time = Date.now();
  const id = '' + tab.id + time + Math.random() * 10000;
  if (!requestQueue[tab.id]) {
    requestQueue[tab.id] = [];
  }

  const newLink = {
    id: id,
    time: time,
    parent: { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl },
    content: tab.url,
    type: ITEM_TYPE.LINK
  };

  if (!queueContains(newLink, tab.id)) {
    requestQueue[tab.id].push(newLink);
    saveRequestQueue();
    safeTabSendMessage(tab.id, { action: 'open-in-page-toolbar', tabId: tab.id });
    safeTabSendMessage(tab.id, { action: 'link-info-update', tabId: tab.id });
  }
}

function addLinkToRequestQueue(link, tab) {
  if (!tab || tab.id === undefined) return;
  const time = Date.now();
  const id = '' + tab.id + time + Math.random() * 10000;
  if (!requestQueue[tab.id]) {
    requestQueue[tab.id] = [];
  }
  const newLink = {
    id: id,
    time: time,
    parent: { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl },
    content: link,
    type: ITEM_TYPE.LINK
  };

  if (!queueContains(newLink, tab.id)) {
    requestQueue[tab.id].push(newLink);
    saveRequestQueue();
    safeTabSendMessage(tab.id, { action: 'open-in-page-toolbar', tabId: tab.id });
    safeTabSendMessage(tab.id, { action: 'link-info-update', tabId: tab.id });
  }
}

function addTextToRequestQueue(previewText, content, tab) {
  if (!tab || tab.id === undefined) return;
  chrome.scripting
    .executeScript({
      target: { tabId: tab.id },
      files: ['contentscripts/toolbarContentscript.js']
    })
    .catch(() => {})
    .finally(() => {
      safeTabSendMessage(tab.id, { action: 'open-in-page-toolbar', tabId: tab.id });
      setTimeout(() => {
        const time = Date.now();
        const id = '' + tab.id + time + Math.random() * 10000;
        if (!requestQueue[tab.id]) {
          requestQueue[tab.id] = [];
        }
        requestQueue[tab.id].push({
          id: id,
          time: time,
          parent: { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl },
          content: content,
          previewText: previewText,
          type: ITEM_TYPE.TEXT
        });
        saveRequestQueue();
        safeTabSendMessage(tab.id, { action: 'link-info-update', tabId: tab.id });
      }, 200);
    });
}

function initMenuItems() {
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {}
    if (!state.isConnected) return;

    if (settings[STORAGE_KEYS.CONTEXT_MENU_SIMPLE] === true) {
      chrome.contextMenus.create(
        {
          id: 'simple_menu_item',
          title: chrome.i18n.getMessage('context_menu_download_with_jdownloader') || 'Download with JDownloader',
          contexts: ['all']
        },
        chromeErrorCallback
      );
    } else {
      chrome.contextMenus.create(
        {
          id: 'download_page',
          title: chrome.i18n.getMessage('context_menu_add_page') || 'Add page',
          contexts: ['all']
        },
        chromeErrorCallback
      );
      chrome.contextMenus.create(
        {
          id: 'download_selection',
          title: chrome.i18n.getMessage('context_menu_add_selection') || 'Add selection',
          contexts: ['selection']
        },
        chromeErrorCallback
      );
      chrome.contextMenus.create(
        {
          id: 'download_link',
          title: chrome.i18n.getMessage('context_menu_add_link') || 'Add link',
          contexts: ['link']
        },
        chromeErrorCallback
      );
      chrome.contextMenus.create(
        {
          id: 'download_video',
          title: chrome.i18n.getMessage('context_menu_add_video') || 'Add video',
          contexts: ['video']
        },
        chromeErrorCallback
      );
      chrome.contextMenus.create(
        {
          id: 'download_audio',
          title: chrome.i18n.getMessage('context_menu_add_audio') || 'Add audio',
          contexts: ['audio']
        },
        chromeErrorCallback
      );
      chrome.contextMenus.create(
        {
          id: 'download_image',
          title: chrome.i18n.getMessage('context_menu_add_image') || 'Add image',
          contexts: ['image']
        },
        chromeErrorCallback
      );
    }
  });
}

function removeDialogFromAllTabs() {
  chrome.tabs.query({}, (tabs) => {
    if (!tabs) return;
    for (const tab of tabs) {
      safeTabSendMessage(tab.id, { action: 'remove-dialog' });
      if (requestQueue[tab.id]) {
        delete requestQueue[tab.id];
      }
    }
    saveRequestQueue();
  });
}

async function initConnected() {
  state.isConnected = true;
  updateBadge(state);
  initMenuItems();
  await syncCnlDeclarativeRules(settings[STORAGE_KEYS.CLICKNLOAD_ACTIVE] !== false);
}

async function initDisconnected() {
  state.isConnected = false;
  updateBadge(state);
  chrome.contextMenus.removeAll(chromeErrorCallback);
  await syncCnlDeclarativeRules(false);
  removeDialogFromAllTabs();
}

function injectContentScripts() {
  chrome.windows.getAll({ populate: true }, (windows) => {
    if (!windows || windows.length === 0) return;
    const manifestScripts = chrome.runtime.getManifest().content_scripts || [];
    let scripts = [];
    for (let i = 0; i < manifestScripts.length; i++) {
      scripts = scripts.concat(manifestScripts[i].js || []);
    }
    if (scripts.length === 0) return;

    for (const win of windows) {
      if (!win.tabs) continue;
      for (const tab of win.tabs) {
        if (!tab.url) continue;
        const isBlockedUrl =
          (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) ||
          tab.url.startsWith('https://chrome.google.com/webstore/') ||
          tab.url.startsWith('https://chromewebstore.google.com/');
        if (isBlockedUrl) continue;

        for (const script of scripts) {
          if (
            script === 'contentscripts/webinterfaceEnhancer.js' &&
            !tab.url.startsWith('https://my.jdownloader.org') &&
            !tab.url.startsWith('http://my.jdownloader.org')
          ) {
            continue;
          }
          if (
            script === 'contentscripts/browserSolverEnhancer.js' &&
            !tab.url.match(/http:\/\/127\.0\.0\.1:\d*\/.*\/.?id=\d+/gi)
          ) {
            continue;
          }
          chrome.scripting
            .executeScript({
              target: { tabId: tab.id },
              files: [script]
            })
            .catch(() => {});
        }
      }
    }
  });
}

// ============================================================================
// Connection State Listener
// ============================================================================
myjdClient.addAPIStateChangeListener((apiState) => {
  const STATES = self.MYJD_CONNECTION_STATES;
  if (apiState === STATES.CONNECTED) {
    state.isConnected = true;
    updateBadge(state);
    safeSendMessage({
      name: 'myjd-toolbar',
      action: 'CONNECTION_STATE_CHANGE',
      data: 'CONNECTED'
    });
    safeSendMessage({
      name: 'myjd-toolbar',
      action: 'session-change',
      data: { isLoggedIn: true }
    });
    chrome.tabs.query({}, (tabs) => {
      if (!tabs) return;
      for (const t of tabs) {
        safeTabSendMessage(t.id, {
          name: 'myjd-toolbar',
          action: 'CONNECTION_STATE_CHANGE',
          data: 'CONNECTED'
        });
      }
    });
  } else if (apiState === STATES.DISCONNECTED) {
    state.isConnected = false;
    updateBadge(state);
    safeSendMessage({
      name: 'myjd-toolbar',
      action: 'CONNECTION_STATE_CHANGE',
      data: 'DISCONNECTED'
    });
    safeSendMessage({
      name: 'myjd-toolbar',
      action: 'session-change',
      data: { isLoggedIn: false }
    });
    chrome.tabs.query({}, (tabs) => {
      if (!tabs) return;
      for (const t of tabs) {
        safeTabSendMessage(t.id, {
          name: 'myjd-toolbar',
          action: 'CONNECTION_STATE_CHANGE',
          data: 'DISCONNECTED'
        });
      }
    });
  }
});

// ============================================================================
// Top-Level Chrome Event Listeners (Required at top-level in MV3)
// ============================================================================

// 1. WebRequest Listener (Non-blocking in MV3)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    handleRc2Request(details);
    handleCnlWebRequest(details);
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

// 2. Context Menu Listener
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await ensureSessionStateLoaded();
  if (!tab || tab.id === undefined) return;

  switch (info.menuItemId) {
    case 'download_page':
      addPageToRequestQueue(tab);
      break;
    case 'download_selection':
      safeTabSendMessage(tab.id, { action: 'get-selection', tabId: tab.id });
      break;
    case 'simple_menu_item':
      if (info) {
        if (info.selectionText) {
          safeTabSendMessage(tab.id, { action: 'get-selection', tabId: tab.id });
        } else if (info.linkUrl) {
          addLinkToRequestQueue(info.linkUrl, tab);
        } else if (info.srcUrl) {
          addLinkToRequestQueue(info.srcUrl, tab);
        } else {
          addPageToRequestQueue(tab);
        }
      }
      break;
    case 'download_link':
      if (info && info.linkUrl) {
        addLinkToRequestQueue(info.linkUrl, tab);
      }
      break;
    case 'download_video':
    case 'download_image':
    case 'download_audio':
      if (info && info.srcUrl) {
        addLinkToRequestQueue(info.srcUrl, tab);
      }
      break;
  }
});

// 3. Storage Change Listener
chrome.storage.onChanged.addListener((changes) => {
  if (!changes) return;
  if (changes[STORAGE_KEYS.CONTEXT_MENU_SIMPLE]) {
    settings[STORAGE_KEYS.CONTEXT_MENU_SIMPLE] = changes[STORAGE_KEYS.CONTEXT_MENU_SIMPLE].newValue;
    initMenuItems();
  }
  if (changes[STORAGE_KEYS.ENHANCE_CAPTCHA_DIALOG]) {
    settings[STORAGE_KEYS.ENHANCE_CAPTCHA_DIALOG] =
      changes[STORAGE_KEYS.ENHANCE_CAPTCHA_DIALOG].newValue;
  }
  if (changes[STORAGE_KEYS.CLIPBOARD_OBSERVER]) {
    settings[STORAGE_KEYS.CLIPBOARD_OBSERVER] = changes[STORAGE_KEYS.CLIPBOARD_OBSERVER].newValue;
    state.clipboardObserver = changes[STORAGE_KEYS.CLIPBOARD_OBSERVER].newValue;
    updateBadge(state);
  }
  if (changes[STORAGE_KEYS.CAPTCHA_PRIVACY_MODE]) {
    settings[STORAGE_KEYS.CAPTCHA_PRIVACY_MODE] =
      changes[STORAGE_KEYS.CAPTCHA_PRIVACY_MODE].newValue;
  }
  if (changes[STORAGE_KEYS.CLICKNLOAD_ACTIVE]) {
    settings[STORAGE_KEYS.CLICKNLOAD_ACTIVE] = changes[STORAGE_KEYS.CLICKNLOAD_ACTIVE].newValue;
    syncCnlDeclarativeRules(state.isConnected && settings[STORAGE_KEYS.CLICKNLOAD_ACTIVE] !== false);
  }
});

// 4. Tabs Lifecycle Listeners
chrome.tabs.onCreated.addListener((tab) => {
  popupCandidates[tab.id] = {
    tab: tab,
    creationTime: Date.now(),
    lastActiveTab: previousActiveTab
  };
  previousActiveTab = tab;
  savePopupCandidates();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete requestQueue[tabId];
  saveRequestQueue();

  if (rc2TabUpdateCallbacks[tabId]) {
    delete rc2TabUpdateCallbacks[tabId];
    saveRc2Tabs();
  }
  removeCaptchaTabCspRule(tabId);
  removeRc2CanCloseCheck(tabId);

  if (removedTabListeners[tabId] && removedTabListeners[tabId].length > 0) {
    for (let i = 0; i < removedTabListeners[tabId].length; i++) {
      try {
        removedTabListeners[tabId][i](popupCandidates[tabId]);
      } catch (e) {}
    }
  }
  delete removedTabListeners[tabId];
  delete popupCandidates[tabId];
  savePopupCandidates();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tabInfo) => {
  await ensureSessionStateLoaded();

  if (popupCandidates[tabId] !== undefined && changeInfo.url !== undefined) {
    popupCandidates[tabId].tab = tabInfo;
    savePopupCandidates();
  }

  const tabCaptchaInfo = rc2TabUpdateCallbacks[tabId];
  let match;
  if (tabCaptchaInfo != null && changeInfo.status === 'complete') {
    if (typeof tabCaptchaInfo.callback === 'function') {
      const listener = tabCaptchaInfo.callback;
      delete tabCaptchaInfo.callback;
      saveRc2Tabs();
      listener(tabId);
    } else if (tabCaptchaInfo.needsInject) {
      delete tabCaptchaInfo.needsInject;
      saveRc2Tabs();
      chrome.scripting
        .executeScript({
          target: { tabId: tabId, allFrames: true },
          files: ['contentscripts/rc2Contentscript.js']
        })
        .then(() => {
          safeTabSendMessage(tabId, { name: 'myjdrc2', action: 'captcha-available' });
        })
        .catch(() => {});
    }
  } else if (
    tabInfo &&
    tabInfo.url &&
    tabInfo.url.indexOf('#rc2jdt') !== -1 &&
    (match = tabInfo.url.match('\\&c=(.*)')) != null
  ) {
    const captchaId = match[1];
    if (captchaId != null) {
      const connected = await myjdClient.ensureSessionLoaded();
      if (connected) {
        try {
          const devices = await myjdClient.listDevices();
          for (const device of devices) {
            try {
              const captchaData = await myjdClient.send(device.id, '/captcha/getCaptchaJob', [captchaId]);
              if (captchaData && captchaData.data && captchaData.data.id != null) {
                const captchaJobResponse = await myjdClient.send(device.id, '/captcha/get', [
                  JSON.stringify(captchaData.data.id),
                  'rawtoken'
                ]);
                if (captchaJobResponse && captchaJobResponse.data != null) {
                  onWebInterfaceCaptchaJobFound(tabId, captchaData.data, captchaJobResponse.data);
                }
              }
            } catch (e) {}
          }
        } catch (e) {}
      } else {
        onLoginNeeded(tabId);
      }
    }
  }
});

// 5. Commands Listener
if (chrome.commands !== undefined) {
  chrome.commands.onCommand.addListener(async (command) => {
    const connected = await myjdClient.ensureSessionLoaded();
    if (!connected) return;
    if (command === 'toggle-clipboard-observer') {
      chrome.storage.local.get([STORAGE_KEYS.CLIPBOARD_OBSERVER], (result) => {
        const currentVal = result ? result[STORAGE_KEYS.CLIPBOARD_OBSERVER] : false;
        const newValue = !(typeof currentVal === 'boolean' && currentVal);
        chrome.storage.local.set({ [STORAGE_KEYS.CLIPBOARD_OBSERVER]: newValue });
        state.clipboardObserver = newValue;
        settings[STORAGE_KEYS.CLIPBOARD_OBSERVER] = newValue;
        updateBadge(state);
      });
    }
  });
}

// 6. Install / Startup Listeners
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'update' || details.reason === 'install') {
    injectContentScripts();
  }
  initializeServiceWorker();
});

chrome.runtime.onStartup.addListener(() => {
  initializeServiceWorker();
});

// ============================================================================
// Central Message Router (chrome.runtime.onMessage)
// ============================================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request) return false;

  (async () => {
    await ensureSessionStateLoaded();
    await initSettings();
    const isLogged = await myjdClient.ensureSessionLoaded();
    state.isConnected = isLogged;

    const name = request.name;
    const action = request.action;

    // ------------------------------------------------------------------------
    // myjd-toolbar messages
    // ------------------------------------------------------------------------
    if (name === 'myjd-toolbar') {
      switch (action) {
        case 'session-info': {
          sendResponse({ data: { isLoggedIn: Boolean(isLogged) } });
          return;
        }

        case 'login': {
          if (request.data && request.data.credentials) {
            try {
              await myjdClient.connect(request.data.credentials);
              await initSettings();
              await initConnected();
              injectContentScripts();
              sendResponse({ data: true });
              safeSendMessage({
                name: 'myjd-toolbar',
                action: 'session-change',
                data: { isLoggedIn: true }
              });
            } catch (error) {
              await initDisconnected();
              sendResponse({ data: false, error: error });
              safeSendMessage({
                name: 'myjd-toolbar',
                action: 'session-change',
                data: { isLoggedIn: false }
              });
            }
          } else {
            await initDisconnected();
            sendResponse({ error: 'credentials missing' });
            safeSendMessage({
              name: 'myjd-toolbar',
              action: 'session-change',
              data: { isLoggedIn: false }
            });
          }
          return;
        }

        case 'logout': {
          try {
            await myjdClient.disconnect();
            chrome.storage.local.clear(chromeErrorCallback);
            await initDisconnected();
            sendResponse({ data: true });
          } catch (error) {
            chrome.storage.local.clear(chromeErrorCallback);
            await initDisconnected();
            sendResponse({ data: false, error: error });
          }
          safeSendMessage({
            name: 'myjd-toolbar',
            action: 'session-change',
            data: { isLoggedIn: false }
          });
          return;
        }

        case 'devices-pull': {
          if (!isLogged) {
            sendResponse({ data: { devices: [] } });
            return;
          }
          try {
            const devices = await myjdClient.listDevices();
            sendResponse({ data: { devices: devices } });
            safeSendMessage({
              name: 'myjd-toolbar',
              action: 'devices-change',
              data: { devices: devices }
            });
          } catch (error) {
            sendResponse({ data: { error: error } });
            safeSendMessage({
              name: 'myjd-toolbar',
              action: 'devices-change',
              data: { error: error }
            });
            safeSendMessage({
              name: 'myjd-toolbar',
              action: 'api-error',
              data: { error: error }
            });
          }
          return;
        }

        case 'send-feedback': {
          if (request.data && request.data.message) {
            try {
              await myjdClient.sendFeedback(request.data.message);
              sendResponse({});
            } catch (e) {
              sendResponse({ error: e });
            }
          } else {
            sendResponse({ error: 'Invalid request' });
          }
          return;
        }

        case 'add-link': {
          if (request.data && request.data.query && request.data.device) {
            try {
              await myjdClient.send(request.data.device.id, '/linkgrabberv2/addLinks', [
                JSON.stringify(request.data.query)
              ]);
              sendResponse({});
            } catch (error) {
              sendResponse({ error: error });
            }
          } else {
            sendResponse({ error: 'Invalid request' });
          }
          return;
        }

        case 'add-cnl': {
          if (request.data && request.data.query && request.data.device) {
            try {
              await myjdClient.send(request.data.device.id, '/flash/addcnl', [
                JSON.stringify(request.data.query)
              ]);
              sendResponse({});
            } catch (error) {
              sendResponse({ error: error });
            }
          } else {
            sendResponse({ error: 'Invalid request' });
          }
          return;
        }

        case 'tab-contentscript-injected': {
          if (sender && sender.tab && sender.tab.id !== undefined) {
            delete requestQueue[sender.tab.id];
            saveRequestQueue();
          }
          sendResponse({});
          return;
        }

        case 'link-info': {
          const localRequestQueue = requestQueue[request.data];
          if (localRequestQueue) {
            sendResponse({ data: localRequestQueue });
          } else {
            sendResponse({ error: 'not_found' });
          }
          return;
        }

        case 'remove-all-requests': {
          if (request.data && request.data.tabId !== undefined) {
            requestQueue[request.data.tabId] = [];
            saveRequestQueue();
          }
          sendResponse({});
          return;
        }

        case 'remove-request': {
          if (request.data && request.data.tabId !== undefined) {
            const tabQueue = requestQueue[request.data.tabId] || [];
            requestQueue[request.data.tabId] = tabQueue.filter(
              (localRequest) => localRequest.id !== request.data.requestId
            );
            saveRequestQueue();
          }
          sendResponse({});
          return;
        }

        case 'whoami': {
          sendResponse({
            username: myjdClient.options ? myjdClient.options.email : undefined
          });
          return;
        }

        case 'new-copy-event': {
          if (sender && sender.tab && settings[STORAGE_KEYS.CLIPBOARD_OBSERVER] === true) {
            safeTabSendMessage(sender.tab.id, {
              action: 'get-selection',
              tabId: sender.tab.id
            });
          }
          sendResponse({});
          return;
        }

        case 'device-poll': {
          if (request.data && request.data.device) {
            const dev = request.data.device;
            try {
              const stats = await myjdClient.send(dev.id, '/polling/poll', [
                JSON.stringify({ jdState: true, aggregatedNumbers: true })
              ]);
              if (stats && stats.data && stats.data[0] && stats.data[1]) {
                const deviceStatus = {
                  state: stats.data[0].eventData.data,
                  eta: stats.data[1].eventData.data.eta,
                  speed: stats.data[1].eventData.data.downloadSpeed,
                  done: stats.data[1].eventData.data.loadedBytes,
                  total: stats.data[1].eventData.data.totalBytes
                };
                safeSendMessage({
                  name: 'myjd-toolbar',
                  action: 'device-poll-' + dev.id,
                  data: deviceStatus
                });
              }
            } catch (error) {
              safeSendMessage({
                name: 'myjd-toolbar',
                action: 'device-poll-' + dev.id,
                data: { error: error }
              });
            }
          }
          sendResponse({});
          return;
        }

        case 'send-api-request': {
          if (request.data && request.data.device && request.data.action) {
            try {
              const result = await myjdClient.send(
                request.data.device.id,
                request.data.action,
                request.data.params !== undefined ? [request.data.params] : []
              );
              sendResponse({ data: result });
            } catch (error) {
              sendResponse({ error: error });
            }
          } else {
            sendResponse({ error: 'Invalid request' });
          }
          return;
        }

        case 'close-in-page-toolbar': {
          let tabid;
          if (request.data && request.data.tabId) {
            tabid = parseFloat(request.data.tabId);
          }
          if (tabid) {
            safeTabSendMessage(tabid, {
              action: 'close-in-page-toolbar',
              tabId: request.data.tabId
            });
            delete requestQueue[tabid];
            saveRequestQueue();
          } else {
            chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
              if (tabs && tabs[0] && tabs[0].id !== undefined) {
                delete requestQueue[tabs[0].id];
                saveRequestQueue();
                safeTabSendMessage(tabs[0].id, {
                  action: 'close-in-page-toolbar',
                  tabId: request.data ? request.data.tabId : tabs[0].id
                });
              }
            });
          }
          sendResponse({});
          return;
        }

        case 'get-clipboard-history': {
          sendResponse({ data: [] });
          return;
        }

        default:
          sendResponse({});
          return;
      }
    }

    // ------------------------------------------------------------------------
    // myjd-selection messages
    // ------------------------------------------------------------------------
    if (name === 'myjd-selection' && action === 'new-selection') {
      if (sender && sender.tab && request.data) {
        addTextToRequestQueue(request.data.text, request.data.html, sender.tab);
      }
      sendResponse({});
      return;
    }

    // ------------------------------------------------------------------------
    // webinterface-enhancer messages
    // ------------------------------------------------------------------------
    if (name === 'webinterface-enhancer') {
      if (action === 'settings') {
        sendResponse({ active: settings[STORAGE_KEYS.ENHANCE_CAPTCHA_DIALOG] });
      } else if (action === 'captcha-done') {
        safeSendMessage({
          name: 'myjdrc2',
          action: 'captcha-done',
          data: request.data
        });
        sendResponse({});
      }
      return;
    }

    // ------------------------------------------------------------------------
    // close-me messages
    // ------------------------------------------------------------------------
    if (name === 'close-me') {
      try {
        if (request.data && request.data.tabId) {
          let tabId = Number.parseInt(request.data.tabId, 10);
          if (request.data.tabId === 'self' && sender && sender.tab) {
            tabId = sender.tab.id;
          }
          if (!isNaN(tabId)) {
            chrome.tabs.get(tabId, (tab) => {
              if (chrome.runtime.lastError || !tab) return;
              chrome.tabs.remove(tabId, chromeErrorCallback);
              chrome.windows.get(tab.windowId, { populate: true }, (win) => {
                if (chrome.runtime.lastError || !win || !win.tabs) return;
                const isNewTab = win.tabs.length === 1 && win.tabs[0].url === 'about:newtab';
                if (win.tabs.length === 0 || isNewTab) {
                  chrome.windows.remove(win.id, chromeErrorCallback);
                }
              });
            });
          }
        }
      } catch (e) {}
      sendResponse({});
      return;
    }

    // ------------------------------------------------------------------------
    // cnl-support & autograbber messages
    // ------------------------------------------------------------------------
    if (name === 'cnl-support') {
      sendResponse({ data: { cnlSupported: true } });
      return;
    }

    if (name === 'autograbber' && action === 'is-active-on-tab') {
      sendResponse({
        data: {
          active: false,
          tabId: sender && sender.tab ? sender.tab.id : undefined
        }
      });
      return;
    }

    // ------------------------------------------------------------------------
    // myjdrc2 (CAPTCHA Browser Solver) messages
    // ------------------------------------------------------------------------
    if (name === 'myjdrc2') {
      switch (action) {
        case 'loaded': {
          if (
            request.callbackUrl !== undefined &&
            request.callbackUrl !== 'undefined' &&
            request.callbackUrl !== 'MYJD'
          ) {
            onRc2FrameLoaded(request);
          }
          sendResponse({});
          return;
        }

        case 'tabmode-init': {
          if (sender && sender.tab && sender.tab.id !== undefined) {
            const tabId = sender.tab.id;
            if (
              request.data &&
              request.data.callbackUrl !== undefined &&
              request.data.callbackUrl !== 'undefined' &&
              request.data.callbackUrl !== 'MYJD'
            ) {
              const handle = setInterval(() => {
                if (!rc2CanCloseIntervalHandles[tabId]) {
                  clearInterval(handle);
                  return;
                }
                checkRc2TabModeCanClose(request, sender);
              }, 1000);
              rc2CanCloseIntervalHandles[tabId] = handle;
              addRemovedTabListener(tabId, () => removeRc2CanCloseCheck(tabId));
            } else if (request.data && request.data.captchaId !== undefined) {
              addRemovedTabListener(tabId, () => {
                chrome.tabs.query(
                  {
                    url: ['http://my.jdownloader.org/*', 'https://my.jdownloader.org/*']
                  },
                  (tabs) => {
                    if (tabs && tabs.length > 0) {
                      for (let i = 0; i < tabs.length; i++) {
                        safeTabSendMessage(tabs[i].id, {
                          name: 'tab-closed',
                          type: 'myjdrc2',
                          data: { captchaId: request.data.captchaId }
                        });
                      }
                    }
                  }
                );
              });
            }
          }
          sendResponse({});
          return;
        }

        case 'response': {
          await sendRc2SolutionToJd(request, sender);
          sendResponse({});
          return;
        }

        case 'mouse-move': {
          onRc2MouseMove(request.callbackUrl, request.timestamp);
          sendResponse({});
          return;
        }

        case 'captcha-new': {
          if (sender && sender.tab && request.data) {
            const parsedParams =
              typeof request.data.params === 'string'
                ? JSON.parse(request.data.params)
                : request.data.params;
            onNewCaptchaAvailable(sender.tab.id, request.data.callbackUrl, parsedParams);
          }
          sendResponse({});
          return;
        }

        case 'tabmode-skip-request': {
          await onSkipRequest(sender, request.data);
          sendResponse({});
          return;
        }

        case 'captcha-get': {
          if (sender && sender.tab) {
            const tabCaptchaInfo = rc2TabUpdateCallbacks[sender.tab.id];
            if (tabCaptchaInfo && tabCaptchaInfo.captchaParams) {
              safeTabSendMessage(sender.tab.id, {
                name: 'myjdrc2',
                action: 'captcha-set',
                data: {
                  callbackUrl: tabCaptchaInfo.captchaParams.callbackUrl,
                  params: tabCaptchaInfo.captchaParams.params
                }
              });
            }
          }
          sendResponse({});
          return;
        }

        case 'inject-captcha-script': {
          // MV3 MAIN world captcha bootstrap helper
          if (sender && sender.tab && request.data) {
            const job = request.data;
            chrome.scripting
              .executeScript({
                target: { tabId: sender.tab.id },
                world: 'MAIN',
                func: (captchaJob) => {
                  window.onResponse = function (response) {
                    const el = document.getElementById('captcha-response');
                    if (el) el.value = response;
                  };
                  const isHCaptcha = captchaJob.challengeType === 'HCaptchaChallenge';
                  const isEnterprise = captchaJob.enterprise === true;
                  window.onClickCallbackScript = function () {
                    if (isHCaptcha && window.hcaptcha) {
                      window.hcaptcha.execute();
                    } else if (window.grecaptcha) {
                      const ns = isEnterprise ? window.grecaptcha.enterprise : window.grecaptcha;
                      if (captchaJob.v3action) {
                        let parsedAction = { action: 'login' };
                        try {
                          parsedAction =
                            typeof captchaJob.v3action === 'string'
                              ? JSON.parse(captchaJob.v3action)
                              : captchaJob.v3action;
                        } catch (e) {}
                        ns.ready(() => {
                          ns.execute(parsedAction).then((token) => {
                            const el =
                              document.getElementById('captcha-response') ||
                              document.getElementById('g-recaptcha-response');
                            if (el) el.value = token;
                          });
                        });
                      } else {
                        ns.execute();
                      }
                    }
                  };
                },
                args: [job]
              })
              .catch(() => {});
          }
          sendResponse({});
          return;
        }

        default:
          sendResponse({});
          return;
      }
    }

    sendResponse({});
  })();

  return true;
});

// ============================================================================
// Initial Service Worker Boot
// ============================================================================
let initSwPromise = null;

function initializeServiceWorker() {
  if (initSwPromise) return initSwPromise;
  initSwPromise = (async () => {
    try {
      await ensureSessionStateLoaded();
      await initSettings();

      // Check any pre-existing localhost captcha tabs
      chrome.tabs.query({ url: 'http://127.0.0.1/*' }, (tabs) => {
        if (!tabs) return;
        for (const tab of tabs) {
          if (tab.url && tab.url.match(/http:\/\/127\.0\.0\.1:\d*\/.*\/.?id=\d+/gi)) {
            chrome.scripting
              .executeScript({
                target: { tabId: tab.id },
                files: ['contentscripts/browserSolverEnhancer.js']
              })
              .catch(() => {});
          }
        }
      });

      try {
        await myjdClient.connect();
        await initConnected();
      } catch (e) {
        await initDisconnected();
      }
    } finally {
      initSwPromise = null;
    }
  })();
  return initSwPromise;
}

initializeServiceWorker();
