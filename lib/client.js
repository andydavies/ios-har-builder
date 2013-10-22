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

var events = require('events'),
    util = require('util'),
    http = require('http'),
    WebSocket = require('ws'),
    common = require('./common.js'),
    Page = require('./page.js');

var Client = function (urls, options) {

    this.host = undefined;
    this.port = undefined;

    this.devices = undefined;
    this.tabs = undefined; // TODO: does this need to be per device or does it not matter here?

    this.urls = urls;
    this.pages = [];
    this.currentPageIndex = -1;
    this.commandId = 1;

    // Timer to capture any requests after onLoad event
    this.watchdog = undefined;
    this.timeout = 2000;

    this._parseOptions(options);
    this._listDevices();

    this.on('devicesListed', function() {
        common.dump("got device list");
        this._listTabs(this.devices[0].url);
    });

    this.on('tabsListed', function() {
        common.dump("got tab list");
        this._connectToBrowser(this.tabs[0].webSocketDebuggerUrl);
    });

//    this._connectToSafari(options);

    // ensure that no new messages are processed after driver.close()
    this.done = false;

    common.dump("Created client\n");
}

util.inherits(Client, events.EventEmitter);

Client.prototype._parseOptions = function(options) {
    // defaults
    var options = options || {};
    this.host = options.host || 'localhost';
    this.port = options.port || 9221;
    // ???
    var chooseTab = options.chooseTab || function () { return 0; };
}

// Need to list - devices, and then get a list of tabs on each device
Client.prototype._listDevices = function () {
    var self = this;

    var url = 'http://' + this.host + ':' + this.port + '/json';
    common.dump(url);
    var request = http.get(url, function (response) {
        var data = '';
        response.on('data', function (chunk) {
            data += chunk;
        });
        response.on('end', function () {
            common.dump('Connected to Proxy: ' + url);
            common.dump(data + "\n");
            self.devices = JSON.parse(data)
            self.emit('devicesListed');
        });
    })
    request.on('error', function (error) {
        common.dump("Emitting 'error' event: " + error.message);
        self.emit('error');
    });
    request.end();    
}

Client.prototype._listTabs = function (url)  {
    var self = this;

    var url = 'http://' + url + '/json';
    common.dump(url);
    var request = http.get(url, function (response) {
        var data = '';
        response.on('data', function (chunk) {
            data += chunk;
        });
        response.on('end', function () {
            common.dump('Listing tabs: ' + url);
            common.dump(data + "\n");
            self.tabs = JSON.parse(data)
            self.emit('tabsListed');
        });
    })
    request.on('error', function (error) {
        common.dump("Emitting 'error' event: " + error.message);
        self.emit('error');
    });
    request.end();    
}

Client.prototype._connectToSafari = function (options) {

    var capturer = this;

    // defaults
    var options = options || {};
    var host = options.address || 'localhost'; // @TODO not used right now
    var port = options.port || 9221; //@TODO not used right now
    var chooseTab = options.chooseTab || function () { return 0; };

    // Need to connect to device and then get the tab

    // @TODO: Code needs to move or be abandoned, but can't get tab list until after connection

    var url = 'http://' + host + ':' + port + '/json';
    common.dump(url);
    var request = http.get(url, function (response) {
        var data = '';
        response.on('data', function (chunk) {
            data += chunk;
        });
        response.on('end', function () {
            common.dump('Connected to Safari: ' + url);
            common.dump(data + "\n");
            var tabs = JSON.parse(data);
            var tabIndex = chooseTab(tabs);
            var tabDebuggerUrl = tabs[tabIndex].url;
            capturer._connectToBrowser(tabDebuggerUrl);
        });
    })
    request.on('error', function (error) {
        common.dump("Emitting 'error' event: " + error.message);
        capturer.emit('error');
    });
    request.end();

//    capturer._connectToBrowser();
}

// TODO  - should be connect to proxy
Client.prototype._connectToBrowser = function (url) {
    var capturer = this;
    
    common.dump("url\n");

    this.ws = new WebSocket(url);

    this.ws.on('open', function () {
        capturer._sendDebuggerCommand('Page.enable');
        capturer._sendDebuggerCommand('Network.enable');
        capturer._sendDebuggerCommand('Network.setCacheDisabled', {'cacheDisabled': true});

        // start!
        capturer._loadNextURL();
    });

    this.ws.on('message', function (data) {
        var message = JSON.parse(data);
        
//        console.log("message: " + data);

        if (message.method && !capturer.done) {
            var page = capturer.pages[capturer.currentPageIndex];

            // done with current URL
            if (message.method == 'Page.loadEventFired') {
                page.setOnLoad(message);
                
                // setup timer to check for network inactivity
                capturer.watchdog = setInterval(function () { capturer._isComplete(page) }, capturer.timeout);

                common.dump('<-- ' + message.method + ': ' + page.url);
            } 
            else if (message.method == 'Page.domContentEventFired') {
                page.setOnDOMContentLoaded(message);
            }
            else if (message.method.match(/^Network./)) {
                page.processMessage(message);
            } 
            else {
                common.dump('Unhandled message: ' + message.method);
                common.dump('Message: ' + data);
            }
        }
    });
}


Client.prototype._isComplete = function(page) {

    if(Date.now() - page.getLastNetworkActivity() > this.timeout) {
        clearInterval(this.watchdog);

        this.emit(page.isOk() ? 'pageEnd' : 'pageError', page.url);

        if (!this._loadNextURL()) {
            common.dump("Emitting 'end' event");
            this.ws.close();
            this.emit('end', this._getHAR());
            this.done = true;
        }
    }
}


Client.prototype._loadNextURL = function () {
    var id = ++this.currentPageIndex;
    var url = this.urls[id];
    if (url) {
        var page = new Page(id, url);
        this.emit('pageStart', url);
        //page.start();
        this._sendDebuggerCommand('Page.navigate', {'url': url});
        this.pages.push(page);
    }
    return url;
}

Client.prototype._getHAR = function () {

    // @TODO: Device isn't really right should be browser probably sniffed from UA
    //var device = this.driver.getDevice();
    var device = {name: "Unknown", version: "Unknown"};

    var har = {
        'log': {
            'version' : '1.2',
            'creator' : {
                'name': 'iOS HAR Builder',
                'version': '0.0.2',
                'comment' : "https://github.com/andydavies/ios-har-builder"
            },
            'browser' : {
                'name' : device.name,
                'version' : device.version
            },
            'pages': [],
            'entries': []
        }
    };

    // merge pages in one HAR
    for (var i in this.pages) {
        var page = this.pages[i];
        if (page.isOk()) {
            var pageHAR = page.getHAR();
            har.log.pages.push(pageHAR.info);
            Array.prototype.push.apply(har.log.entries, pageHAR.entries);
        }
    }

    return har;
}

Client.prototype._sendDebuggerCommand = function (method, params) {
    common.dump('--> ' + method + ' ' + (JSON.stringify(params) || ''));
    this.ws.send(
        JSON.stringify({
            'id': this.commandId++,
            'method': method,
            'params': params
        })
    );
}

module.exports = Client;
