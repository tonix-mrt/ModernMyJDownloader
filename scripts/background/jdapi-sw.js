'use strict';

/**
 * MyJDownloader API Client for Chrome Manifest V3 Service Worker
 * Uses native fetch(), CryptoJS, and chrome.storage.local (no DOM / jQuery / RequireJS dependencies).
 */

(function (globalScope) {
  const LOCAL_STORAGE_KEY = 'jdapi/src/core/core.js';
  const LOCAL_STORAGE_RECONNECT_LOCK_KEY = 'jdapi/src/core/coreRequestHandler.js';
  const DEFAULT_API_ROOT = 'https://api.jdownloader.org';
  const DEFAULT_APP_KEY = 'myjd_webextension_chrome';

  const CONNECTION_STATES = {
    CONNECTED: 0,
    PENDING: 1,
    RECONNECT: 2,
    DISCONNECTED: 3
  };

  // Extend CryptoJS WordArray with firstHalf / secondHalf helpers
  if (typeof CryptoJS !== 'undefined' && CryptoJS.lib && CryptoJS.lib.WordArray) {
    CryptoJS.lib.WordArray.firstHalf = function () {
      return new CryptoJS.lib.WordArray.init(this.words.slice(0, this.words.length / 2));
    };
    CryptoJS.lib.WordArray.secondHalf = function () {
      return new CryptoJS.lib.WordArray.init(this.words.slice(this.words.length / 2, this.words.length));
    };
  }

  function toWordArray(obj) {
    if (!obj) return undefined;
    if (typeof obj.firstHalf === 'function' && Array.isArray(obj.words)) {
      return obj;
    }
    if (Array.isArray(obj.words)) {
      return new CryptoJS.lib.WordArray.init(obj.words.slice(0), obj.sigBytes);
    }
    return undefined;
  }

  function serializeParams(params) {
    const parts = [];
    for (const key of Object.keys(params)) {
      const value = params[key];
      if (value !== undefined && value !== null) {
        parts.push(
          encodeURIComponent(key).replace(/%20/g, '+') +
            '=' +
            encodeURIComponent(String(value)).replace(/%20/g, '+')
        );
      }
    }
    return parts.join('&');
  }

  const CryptoUtils = {
    hashPassword(email, pass, domain) {
      return CryptoJS.SHA256(
        CryptoJS.enc.Utf8.parse(email.toLowerCase() + pass + domain.toLowerCase())
      );
    },

    processPassword(options) {
      if (!options.email || !options.pass) {
        throw new Error('processPassword requires options.email and options.pass');
      }
      options.loginSecret = this.hashPassword(options.email, options.pass, 'server');
      options.deviceSecret = this.hashPassword(options.email, options.pass, 'device');
      delete options.pass;
    },

    initialiseConnection(options, sessiontoken, regaintoken) {
      if (!options.loginSecret && !options.serverEncryptionToken) {
        throw new Error('either loginSecret or serverEncryptionToken must be set');
      }
      if (!options.deviceSecret) {
        throw new Error('deviceSecret not set');
      }
      if (!sessiontoken || !regaintoken) {
        throw new Error('sessiontoken and regaintoken are required');
      }

      options.sessiontoken = sessiontoken;
      options.regaintoken = regaintoken;

      const ses = CryptoJS.enc.Hex.parse(options.sessiontoken);
      if (options.loginSecret) {
        const tot = options.loginSecret.clone().concat(ses);
        options.serverEncryptionTokenOld = options.serverEncryptionToken;
        options.serverEncryptionToken = CryptoJS.SHA256(tot);
        delete options.loginSecret;
      } else {
        options.serverEncryptionTokenOld = options.serverEncryptionToken;
        const tot = options.serverEncryptionToken.clone().concat(ses);
        options.serverEncryptionToken = CryptoJS.SHA256(tot);
      }

      const deviceSecret = options.deviceSecret.clone();
      const totDev = deviceSecret.concat(ses);
      options.deviceEncryptionTokenOld = options.deviceEncryptionToken;
      options.deviceEncryptionToken = CryptoJS.SHA256(totDev);
    },

    encryptJSON(secret, plain) {
      if (!secret) {
        return { data: plain };
      }
      const iv = secret.firstHalf();
      const key = secret.secondHalf();
      const aesEncrypted = CryptoJS.AES.encrypt(JSON.stringify(plain), key, {
        mode: CryptoJS.mode.CBC,
        iv: iv
      });
      return {
        contentType: 'application/aesjson; charset=utf-8',
        iv: iv,
        key: key,
        data: aesEncrypted.toString()
      };
    },

    decryptJSON(iv, key, encrypted) {
      try {
        const plainRaw = CryptoJS.AES.decrypt(encrypted, key, {
          mode: CryptoJS.mode.CBC,
          iv: iv
        }).toString(CryptoJS.enc.Utf8);
        if (plainRaw && typeof plainRaw === 'string') {
          return JSON.parse(plainRaw);
        }
        return null;
      } catch (e) {
        return encrypted;
      }
    }
  };

  const storageStore = {
    getItem(key) {
      return new Promise((resolve) => {
        chrome.storage.local.get(key, (result) => {
          resolve(result || {});
        });
      });
    },
    setItem(key, value) {
      return new Promise((resolve) => {
        const obj = {};
        obj[key] = value;
        chrome.storage.local.set(obj, () => resolve());
      });
    },
    removeItem(key) {
      return new Promise((resolve) => {
        chrome.storage.local.remove(key, () => resolve());
      });
    }
  };

  let lastRid = 0;
  function getRID() {
    let rid = Date.now();
    if (lastRid >= rid) {
      rid = lastRid + 1;
    }
    lastRid = rid;
    return rid;
  }

  class MyJDClientSW {
    constructor(config = {}) {
      this.apiRoot = config.API_ROOT || DEFAULT_API_ROOT;
      this.appKey = config.APP_KEY || DEFAULT_APP_KEY;
      this.options = {};
      this.apiState = CONNECTION_STATES.DISCONNECTED;
      this.stateListeners = [];
      this.devices = {};
      this.activeDeviceId = null;
      this.reconnectPromise = null;
    }

    addAPIStateChangeListener(listener) {
      if (typeof listener === 'function' && !this.stateListeners.includes(listener)) {
        this.stateListeners.push(listener);
      }
    }

    _setAPIState(newState) {
      if (this.apiState === newState) return;
      this.apiState = newState;
      for (const listener of this.stateListeners) {
        try {
          listener(newState);
        } catch (err) {
          console.error('[MyJDClientSW] state listener error:', err);
        }
      }
    }

    isConnected() {
      return (
        this.apiState === CONNECTION_STATES.CONNECTED &&
        Boolean(this.options && this.options.sessiontoken)
      );
    }

    async ensureSessionLoaded() {
      if (this.options && this.options.sessiontoken && this.options.serverEncryptionToken) {
        if (this.apiState !== CONNECTION_STATES.CONNECTED) {
          this._setAPIState(CONNECTION_STATES.CONNECTED);
        }
        return true;
      }
      try {
        const result = await storageStore.getItem(LOCAL_STORAGE_KEY);
        if (!result || !result[LOCAL_STORAGE_KEY]) {
          return false;
        }
        const restored = JSON.parse(result[LOCAL_STORAGE_KEY]);
        if (!restored || !restored.sessiontoken) {
          return false;
        }
        this.options = Object.assign({}, restored, {
          API_ROOT: this.apiRoot,
          serverEncryptionToken: toWordArray(restored.serverEncryptionToken),
          deviceEncryptionToken: toWordArray(restored.deviceEncryptionToken),
          deviceSecret: toWordArray(restored.deviceSecret)
        });
        if (restored.serverEncryptionTokenOld) {
          this.options.serverEncryptionTokenOld = toWordArray(restored.serverEncryptionTokenOld);
        }
        if (restored.deviceEncryptionTokenOld) {
          this.options.deviceEncryptionTokenOld = toWordArray(restored.deviceEncryptionTokenOld);
        }
        this._setAPIState(CONNECTION_STATES.CONNECTED);
        return true;
      } catch (e) {
        return false;
      }
    }

    async connect(credentials) {
      this._setAPIState(CONNECTION_STATES.PENDING);

      if (credentials && credentials.email && (credentials.pass || credentials.password)) {
        const options = {
          email: String(credentials.email).trim(),
          pass: credentials.pass || credentials.password,
          API_ROOT: this.apiRoot
        };
        CryptoUtils.processPassword(options);

        const params = {
          email: options.email,
          appkey: this.appKey,
          rid: 0
        };
        let queryString = '/my/connect?' + serializeParams(params);
        const signature = CryptoJS.HmacSHA256(
          CryptoJS.enc.Utf8.parse(queryString),
          options.loginSecret
        ).toString(CryptoJS.enc.Hex);
        queryString += '&signature=' + signature;

        const data = await this._rawEncryptedFetch(
          this.apiRoot + queryString,
          { method: 'POST' },
          options.loginSecret.firstHalf(),
          options.loginSecret.secondHalf()
        );

        if (!data || data.rid !== params.rid) {
          this._setAPIState(CONNECTION_STATES.DISCONNECTED);
          throw { type: 'CHALLENGE_FAILED', status: 200 };
        }

        CryptoUtils.initialiseConnection(options, data.sessiontoken, data.regaintoken);
        this.options = options;
        await storageStore.setItem(LOCAL_STORAGE_KEY, JSON.stringify(options));
        this._setAPIState(CONNECTION_STATES.CONNECTED);
        return options;
      } else {
        const loaded = await this.ensureSessionLoaded();
        if (!loaded) {
          this._setAPIState(CONNECTION_STATES.DISCONNECTED);
          throw { type: 'OFFLINE', status: -1 };
        }
        return this.options;
      }
    }

    async reconnect() {
      if (this.reconnectPromise) {
        return this.reconnectPromise;
      }

      this.reconnectPromise = (async () => {
        try {
          await this.ensureSessionLoaded();
          if (!this.options || !this.options.sessiontoken || !this.options.regaintoken || !this.options.serverEncryptionToken) {
            throw { type: 'AUTH_FAILED', status: 403 };
          }

          this._setAPIState(CONNECTION_STATES.RECONNECT);
          const rid = getRID();
          const params = {
            appkey: this.appKey,
            sessiontoken: this.options.sessiontoken,
            regainToken: this.options.regaintoken,
            rid: rid
          };
          let queryString = '/my/reconnect?' + serializeParams(params);
          const signature = CryptoJS.HmacSHA256(
            CryptoJS.enc.Utf8.parse(queryString),
            this.options.serverEncryptionToken
          ).toString(CryptoJS.enc.Hex);
          queryString += '&signature=' + signature;

          const data = await this._rawEncryptedFetch(
            this.apiRoot + queryString,
            { method: 'POST' },
            this.options.serverEncryptionToken.firstHalf(),
            this.options.serverEncryptionToken.secondHalf()
          );

          CryptoUtils.initialiseConnection(this.options, data.sessiontoken, data.regaintoken);
          await storageStore.removeItem(LOCAL_STORAGE_RECONNECT_LOCK_KEY);
          await storageStore.setItem(LOCAL_STORAGE_KEY, JSON.stringify(this.options));
          this._setAPIState(CONNECTION_STATES.CONNECTED);
          return this.options;
        } catch (err) {
          await this.disconnect();
          throw err;
        } finally {
          this.reconnectPromise = null;
        }
      })();

      return this.reconnectPromise;
    }

    async disconnect() {
      await this.ensureSessionLoaded();
      if (this.options && this.options.sessiontoken && this.options.serverEncryptionToken) {
        try {
          const rid = getRID();
          const params = {
            rid: rid,
            sessiontoken: this.options.sessiontoken
          };
          let queryString = '/my/disconnect?' + serializeParams(params);
          const signature = CryptoJS.HmacSHA256(
            CryptoJS.enc.Utf8.parse(queryString),
            this.options.serverEncryptionToken
          ).toString(CryptoJS.enc.Hex);
          queryString += '&signature=' + signature;

          await this._rawEncryptedFetch(
            this.apiRoot + queryString,
            { method: 'POST' },
            this.options.serverEncryptionToken.firstHalf(),
            this.options.serverEncryptionToken.secondHalf()
          );
        } catch (e) {
          // Ignore network errors during disconnect
        }
      }
      this.options = {};
      this.devices = {};
      await storageStore.removeItem(LOCAL_STORAGE_KEY);
      this._setAPIState(CONNECTION_STATES.DISCONNECTED);
    }

    async _rawEncryptedFetch(url, fetchOptions, aesIv, aesKey, timeoutMs = 15000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(url, Object.assign({}, fetchOptions, { signal: controller.signal }));
      } catch (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') {
          throw { type: 'TIMEOUT', status: -1 };
        }
        throw { type: 'CONNECTION_REFUSED', status: -1 };
      }
      clearTimeout(timer);

      const text = await response.text();
      if (!response.ok) {
        let parsedError;
        try {
          parsedError = JSON.parse(text);
        } catch (e) {
          parsedError = { type: 'UNKNOWN', status: response.status, responseText: text };
        }
        if (parsedError && parsedError.status === undefined) {
          parsedError.status = response.status;
        }
        throw parsedError;
      }

      if (aesIv && aesKey) {
        const decrypted = CryptoUtils.decryptJSON(aesIv, aesKey, text);
        if (decrypted && typeof decrypted === 'object') {
          return decrypted;
        }
        try {
          return JSON.parse(text);
        } catch (e) {
          return decrypted;
        }
      }

      try {
        return JSON.parse(text);
      } catch (e) {
        return text;
      }
    }

    async serverCall(action, params = {}, retryCount = 0) {
      const loaded = await this.ensureSessionLoaded();
      if (!loaded) {
        throw { type: 'AUTH_FAILED', status: 403 };
      }

      const rid = getRID();
      let queryString = action + '?sessiontoken=' + this.options.sessiontoken + '&rid=' + rid;
      const unencrypted = {
        apiVer: 1,
        params: params !== undefined && JSON.stringify(params) !== '{}' ? [params] : [],
        url: queryString,
        rid: rid
      };

      const encryptedJSON = CryptoUtils.encryptJSON(this.options.serverEncryptionToken, unencrypted);
      const signature = CryptoJS.HmacSHA256(
        CryptoJS.enc.Utf8.parse(queryString),
        this.options.serverEncryptionToken
      ).toString(CryptoJS.enc.Hex);
      queryString += '&signature=' + signature;

      try {
        return await this._rawEncryptedFetch(
          this.apiRoot + queryString,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: encryptedJSON.data
          },
          encryptedJSON.iv,
          encryptedJSON.key
        );
      } catch (err) {
        if (err && err.type === 'TOKEN_INVALID' && retryCount === 0) {
          await this.reconnect();
          return this.serverCall(action, params, retryCount + 1);
        }
        if (err && err.type === 'AUTH_FAILED') {
          await this.disconnect();
        }
        throw err;
      }
    }

    async deviceCall(deviceId, action, postData = [], localURL = null, timeoutMs = 15000, retryCount = 0) {
      const loaded = await this.ensureSessionLoaded();
      if (!loaded) {
        throw { type: 'AUTH_FAILED', status: 403 };
      }

      const rid = getRID();
      const jdData = {
        url: action,
        params: Array.isArray(postData) ? postData : [postData],
        apiVer: 1,
        rid: rid
      };

      const encryptedJSON = CryptoUtils.encryptJSON(this.options.deviceEncryptionToken, jdData);
      const baseRoot = localURL || (this.devices[deviceId] && this.devices[deviceId].localURL) || this.apiRoot;
      const url = baseRoot + '/t_' + this.options.sessiontoken + '_' + deviceId + action;

      try {
        return await this._rawEncryptedFetch(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': encryptedJSON.contentType },
            body: encryptedJSON.data
          },
          encryptedJSON.iv,
          encryptedJSON.key,
          timeoutMs
        );
      } catch (err) {
        // If local direct connection failed, fall back to remote API root
        if (baseRoot !== this.apiRoot && retryCount === 0) {
          if (this.devices[deviceId]) {
            delete this.devices[deviceId].localURL;
          }
          return this.deviceCall(deviceId, action, postData, this.apiRoot, timeoutMs, retryCount + 1);
        }
        if (err && err.type === 'TOKEN_INVALID' && retryCount === 0) {
          await this.reconnect();
          return this.deviceCall(deviceId, action, postData, localURL, timeoutMs, retryCount + 1);
        }
        if (err && err.type === 'AUTH_FAILED') {
          await this.disconnect();
        }
        throw err;
      }
    }

    async listDevices() {
      const response = await this.serverCall('/my/listdevices', {});
      const list = (response && Array.isArray(response.list)) ? response.list : [];
      for (const dev of list) {
        if (!this.devices[dev.id]) {
          this.devices[dev.id] = { id: dev.id, name: dev.name, data: dev };
        } else {
          this.devices[dev.id].name = dev.name;
          this.devices[dev.id].data = dev;
        }
      }
      // Asynchronously probe local direct connection availability
      this._checkForLocalMode(list).catch(() => {});
      return list;
    }

    async _checkForLocalMode(devices) {
      if (!Array.isArray(devices) || devices.length === 0) return;
      for (const dev of devices) {
        try {
          const result = await this.deviceCall(dev.id, '/device/getDirectConnectionInfos', [], this.apiRoot, 5000);
          if (result && result.data && Array.isArray(result.data.infos) && result.data.infos.length > 0) {
            for (const info of result.data.infos) {
              if (!info || !info.ip || !info.port) continue;
              const localURL = 'https://' + info.ip.replace(/\./g, '-') + '.mydns.jdownloader.org:' + info.port;
              try {
                await this.deviceCall(dev.id, '/device/ping', [], localURL, 3000);
                if (this.devices[dev.id]) {
                  if (
                    !this.devices[dev.id].localURL ||
                    localURL.includes('127-0-0-1.mydns.')
                  ) {
                    this.devices[dev.id].localURL = localURL;
                  }
                }
              } catch (_) {
                // Local address unreachable
              }
            }
          }
        } catch (_) {
          // Ignore direct connection probe errors
        }
      }
    }

    async send(deviceId, call, params = []) {
      const cleanParams = Array.isArray(params) ? params.filter((el) => el != null) : [params];
      return this.deviceCall(deviceId, call, cleanParams);
    }

    async sendFeedback(message) {
      const manifest = chrome.runtime.getManifest();
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'ServiceWorker';
      const fullMessage =
        'UA: ' + ua + '\n\n[WEB EXTENSION] Version ' + manifest.version + '\n' + (message || '');
      return this.serverCall('/my/feedback', fullMessage);
    }
  }

  globalScope.MyJDClientSW = MyJDClientSW;
  globalScope.MYJD_CONNECTION_STATES = CONNECTION_STATES;
})(self);
