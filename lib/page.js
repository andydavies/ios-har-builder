/*
 * Copyright (c) 2013 Andrea Cardaci <cyrus.and@gmail.com>
 * Copyright (c) 2013 Andy Davies, http://andydavies.me
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software. 
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

var url = require('url');
var common = require('./common.js');

var Page = function (id, url) {
    this.id = id;
    this.url = url;
    this.entries = {};
    this.startTime = undefined;
    this.endTime = undefined;
    this.originalRequestId = undefined;
    this.error = true;

    this.onLoad = undefined;
    this.onDOMContentLoaded = undefined;

    // Timestamp for last network activity, used to capture resources after onload
    this.lastNetworkActivity = undefined;
}

Page.prototype.isOk = function () {
    return !this.error;
}

Page.prototype.setOnLoad = function(message) {
    this.onLoad = message.params.timestamp;
}

Page.prototype.setOnDOMContentLoaded = function(message) {
    this.onDOMContentLoaded = message.params.timestamp;
}

Page.prototype.getLastNetworkActivity = function() {
    return this.lastNetworkActivity;
}

// typical sequence:
//
// Network.requestWillBeSent # about to send a request
// Network.responseReceived  # headers received
// Network.dataReceived      # data chunk received
// [...]
// Network.loadingFinished   # full response received
Page.prototype.processMessage = function (message) {

    this.lastNetworkActivity = Date.now();

    var id = message.params.requestId;

    switch (message.method) {
        case 'Network.requestWillBeSent':

            if (!this.originalRequestId &&
                sameURL(this.url, message.params.request.url)) {
                this.originalRequestId = id;
            }
            this.entries[id] = {
                'requestEvent': message.params,
                'responseEvent': undefined,
                'responseLength': 0,
                'encodedResponseLength': 0,
                'requestStarted' : message.params.timestamp,
                'responseStarted' : undefined,
                'responseFinished': undefined
            };
            break;

        case 'Network.dataReceived':
            if (id in this.entries) {
                this.entries[id].responseLength += message.params.dataLength;
                this.entries[id].encodedResponseLength += message.params.encodedDataLength;
                break;
            }
            return;

        case 'Network.responseReceived': // This is actually the start of the response
            if (id in this.entries) {
                this.entries[id].responseEvent = message.params;
                this.entries[id].responseStarted = message.params.timestamp;
                break;
            }
            return;

        case 'Network.loadingFinished':

            if (id == this.originalRequestId) {
                this.error = false;
            }
            if (id in this.entries) {
                this.entries[id].responseFinished = message.params.timestamp;
                break;
            }

            return;

        case 'Network.loadingFailed':

            if (id in this.entries) {
                break; // just log dump
            }

            return;

        default:
            common.dump('Unhandled message: ' + message.method);
    }

    common.dump('<-- ' + '[' + id + '] ' + message.method);
}


Page.prototype.getHAR = function () {

    var started = this.entries[this.originalRequestId].requestStarted;

    var har = {
        'info': {
            'startedDateTime': new Date(started * 1000).toISOString(),
            'id': this.id.toString(),
            'title': this.url,
            'pageTimings': {
                'onLoad': timeDeltaInMillis(started, this.onLoad),
                'onContentLoad': timeDeltaInMillis(started, this.onDOMContentLoaded)
            }
        },
        'entries': []
    };

    for (var requestId in this.entries) {
        var entry = this.entries[requestId];

        // skip dataURIs
        if(isDataURI(entry.requestEvent.request.url)) continue;

        // skip incomplete entries
        if (!entry.responseEvent || !entry.responseFinished) continue; // @TODO not sure about this - what about incomplete requests?

        // analyze headers
        var requestHeaders = convertHeaders(entry.requestEvent.request.headers);
        var responseHeaders = convertHeaders(entry.responseEvent.response.headers);

        // add status line length
        requestHeaders.size += (entry.requestEvent.request.method.length +
                                entry.requestEvent.request.url.length +
                                12); // "HTTP/1.x" + "  " + "\r\n"

        responseHeaders.size += (entry.responseEvent.response.status.toString().length +
                                 entry.responseEvent.response.statusText.length +
                                 12); // "HTTP/1.x" + "  " + "\r\n"

        // query string
        var queryString = convertQueryString(entry.requestEvent.request.url);

        // fill entry
        har.entries.push({
            'pageref': this.id.toString(),
            'startedDateTime': new Date(entry.requestStarted * 1000).toISOString(),
            'time': timeDeltaInMillis(entry.requestStarted, entry.responseFinished),
            'request': {
                'method': entry.requestEvent.request.method,
                'url': entry.requestEvent.request.url,
                'httpVersion': 'HTTP/1.1', // TODO
                'cookies': [], // TODO
                'headers': requestHeaders.pairs,
                'queryString': queryString,
                'headersSize': requestHeaders.size,
                'bodySize': entry.requestEvent.request.headers['Content-Length'] || -1,
            },
            'response': {
                'status': entry.responseEvent.response.status,
                'statusText': entry.responseEvent.response.statusText,
                'httpVersion': 'HTTP/1.1', // @TODO
                'cookies': [], // @TODO
                'headers': responseHeaders.pairs,
                'redirectURL': '', // @TODO
                'headersSize': responseHeaders.size,
                'bodySize': entry.encodedResponseLength,
                'content': {
                    'size': entry.responseLength,
                    'mimeType': entry.responseEvent.response.mimeType,
                    'compression': entry.responseLength - entry.encodedResponseLength // @TODO: Check this
                }
            },
            'cache': {},
            'timings': calculateTimings(entry)
        });
    }

    return har;
}

function calculateTimings(entry) {

    var timing = entry.responseEvent.response.timing;

    // No timing object i.e. current Safari 
    if (!timing) {
        return {
            'blocked': -1,
            'dns': -1,
            'connect': -1,
            'send': 0,
            'wait': timeDeltaInMillis(entry.requestStarted, entry.responseStarted),
            'receive': timeDeltaInMillis(entry.responseStarted, entry.responseFinished),
            'ssl': -1
        };
    }

    // compute timing informations: input
    var dnsTime = timeDelta(timing.dnsStart, timing.dnsEnd);
    var proxyTime = timeDelta(timing.proxyStart, timing.proxyEnd);
    var connectTime = timeDelta(timing.connectStart, timing.connectEnd);
    var sslTime = timeDelta(timing.sslStart, timing.sslEnd);
    var sendTime = timeDelta(timing.sendStart, timing.sendEnd);

    // compute timing informations: output
    var dns = proxyTime + dnsTime; // @TODO: Proxy time is not really part of DNS
    var connect = connectTime;
    var ssl = sslTime;
    var send = sendTime;
    var wait = timing.receiveHeadersEnd - timing.sendEnd;
    var receive = Math.round(entry.responseFinished * 1000 -
                             timing.requestTime * 1000 -
                             timing.receiveHeadersEnd);
    var blocked = -1; // @TODO
//    var totalTime = dns + connect + ssl + send + wait + receive;
    
    return {
        'blocked': blocked,
        'dns': timing.dnsStart == -1 ? -1 : dns, // -1 = n.a.
        'connect': timing.connectStart == -1 ? -1 : connect, // -1 = n.a.
        'send': send,
        'wait': wait,
        'receive': receive,
        'ssl': timing.sslStart == -1 ? -1 : ssl // -1 = n.a.
    }  
}

function convertQueryString(fullUrl) {
    var query = url.parse(fullUrl, true).query;
    var pairs = [];
    for (var name in query) {
        var value = query[name];
        pairs.push({'name': name, 'value': value.toString()});
    }
    return pairs;
}

function convertHeaders(headers) {
    headersObject = {'pairs': [], 'size': -1};
    if (Object.keys(headers).length) {
        headersObject.size = 2; // trailing "\r\n"
        for (var name in headers) {
            var value = headers[name];
            headersObject.pairs.push({'name': name, 'value': value});
            headersObject.size += name.length + value.length + 4; // ": " + "\r\n"
        }
    }
    return headersObject;
}

function timeDelta(start, end) { 
    return start != -1 && end != -1 ? (end - start) : 0; // @TODO : check for undefined.
}

function timeDeltaInMillis(start, end) { 
    return Math.round(timeDelta(start, end) * 1000);
}

function sameURL(a, b) {
    return JSON.stringify(url.parse(a)) == JSON.stringify(url.parse(b));
}

function isDataURI(uri) {
    return uri.substr(0, 5) === "data:";
}

module.exports = Page;
