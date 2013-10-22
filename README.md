#ios-har-builder
===================

Loads pages in iOS Safari and builds a HTTP Archive (HAR) file for page load.

**This is work-in-progress and liable to change**

##Install

1. Clone repository
2. Run ```npm install``` to install dependencies
3. Install Google's proxy that connects Chrome DevTools to iOS WebKit - https://github.com/google/ios-webkit-debug-proxy (there's a homebrew recipe for this)

##Usage

Start the proxy

Then either the iOS Simulator and launch Safari, or connect an iPhone/iPad via USB cable

    Usage: bin/ios-har-builder [options] URL...

    options:
      --output, -o   Dump generated HAR to file instead of stdout
      --verbose, -v  Enable verbose output

N.B. Options for host and port don't currently work

    Example:    bin/ios-har-builder -o example.har http://m.guardian.co.uk

##Credits

ios-har-builder is based on a fork of chrome-har-capturer (https://github.com/cyrus-and/chrome-har-capturer) by Andrea Cardaci (cyrus.and@gmail.com)

It's a separate fork for now as there are some differences in behaviour between Chrome and Safari e.g. lack of navigation / resource timing in Safari, Safari wraps the WebKit debug protocol in RPC etc.

##Issues

- Cookies aren't currently supported
- Code needs cleaning up and refactoring in several places
- Host and Port parameters don't work

##Resources

- [HAR 1.2 Spec][1]
- [HAR Viewer][2]
- [Chrome Developer Tools: Remote Debugging Protocol v1.0][3]

[1]: http://www.softwareishard.com/blog/har-12-spec/
[2]: http://www.softwareishard.com/blog/har-viewer/
[3]: https://developers.google.com/chrome-developer-tools/docs/protocol/1.0/
[4]: https://developers.google.com/chrome-developer-tools/docs/network
