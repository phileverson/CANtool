/**
 * @file canbus.js
 * @namespace canbusjs
 * Module for interfacing with CAN bus systems
 */

"use strict";

/**
 * @module canbus
 */
var canbus = {};

/**
 * Defines a single CAN bus frame.
 * @class canbus.frame
 * @constructor
 * @param {Number} id identifier of CAN frame
 */
canbus.frame = function(id) {
    /**
     * Identifier of frame
     * @property id
     * @type Number
     */
    this.id = id;

    /**
     * Data Length Code (DLC) of frame
     * @property dlc
     * @default 0
     * @type Number
     */
    this.dlc = 0;

    /**
     * Timestamp (DLC) of frame
     * @property dlc
     * @default 0
     * @type Number
     */
    this.timestamp = undefined;

    /**
     * Frame data
     * @property data
     * @type Array
     */
    this.data = [];

    /**
     * Extended identifier flag
     * @property is_ext_id
     * @type Boolean
     */
    this.is_ext_id = false;

    /**
     * Remote flag frame
     * @property is_remote
     * @type Boolean
     */
    this.is_remote = false;
}

/**
 * Defines a serial line CAN (slcan) interface.
 * @class canbus.slcan
 * @constructor
 * @param {String} dev_str path to, or name of serial device
 * @param {Integer} speed speed setting to use (0-8)
 * @param {Function} recvFrameCallback callback function for received frames
 */
canbus.slcan = function(dev_str, speed, recvFrameCallback) {
    this._dev_str = dev_str;
    this._speed = speed;
    this._conn = null;

    // variables to hold the incomming string until it terminates
    this._recv_count = 0;
    this._recv_str = "";

    /**
     * Callback function to fire when frame is received
     * @property recvFrameCallback
     * @type Function
     */
    this.recvFrameCallback = recvFrameCallback;
}

/**
 * Length in characters of a standard CAN identifier
 * @property STD_ID_LEN
 * @type Number
 * @final
 */
canbus.slcan.STD_ID_LEN = 3;

/**
 * Length in characters of an extended CAN identifier
 * @property EXT_ID_LEN
 * @type Number
 * @final
 */
canbus.slcan.EXT_ID_LEN = 8;

/**
 * Open a connection to the serial device
 * @method open
 */
canbus.slcan.prototype.open = function() {
    this._conn = chrome.serial.connect(this._dev_str, {},
                                       this._serialOpenCallback.bind(this));
    chrome.serial.onReceive.addListener(this._serialRecvCallback.bind(this));
}

/**
 * Send a CAN frame
 * @method send
 * @param {canbus.frame} frame frame to send
 */
canbus.slcan.prototype.send = function(frame) {
    // ensure that we have a connection to the device
    if (!this._conn) {
        throw "Not connected to serial device";
    }

    // convert frame to slcan string
    var slcan_str = this._packFrame(frame);

    this._serialWrite(slcan_str);

}

/**
 * Send a string on the serial port
 * @param {String} str string to send
 * @private
 */
canbus.slcan.prototype._serialWrite = function(str) {
    // pack string into ArrayBuffer
    var buf = new ArrayBuffer(str.length);
    var buf_view = new Uint8Array(buf);
    for (var i = 0; i < str.length; i++) {
        buf_view[i] = str.charCodeAt(i);
    }

    // send to serial device
    chrome.serial.send(this._conn.connectionId, buf, function(){});
}

/**
 * callback for serial port opening
 * @method _serialOpenCallback
 * @param conn
 * @private
 */
canbus.slcan.prototype._serialOpenCallback = function(conn) {
    if (!conn) {
        // open failed!
        console.log('failed to connect to device ' + this._dev_str);
        return;
    }

    this._conn = conn;
    console.log('connected to device ' + this._dev_str);
    chrome.serial.flush(conn.connectionId, function(){});

    // open can communication
    this._serialWrite("S" + this._speed + "\r");
    this._serialWrite("O\r");
}

/**
 * callback for receiving data from the serial port
 * @method _serialRecvCallback
 * @param received
 * @private
 */
canbus.slcan.prototype._serialRecvCallback = function(received) {
    var data = new Uint8Array(received.data);

    // receive the characters and append to the received string
    for (var i = 0; i < data.length; i++) {
        // convert to byte
        var char = String.fromCharCode(data[i]);
        this._recv_count++;
        // check if character terminates string
        if (char == '\r') {
            var tmp = this._recv_str;
            // reset the string and counters
            this._recv_str = "";
            this._recv_count = 0;

            // call the handler
            var frame = this._parseFrame(tmp);
            // set the timestamp
            frame.timestamp = Date.now();
	    
            this.recvFrameCallback(frame);
        } else {
            this._recv_str += char;
        }
    }
}

/**
 * Helper function to parse a slcan string into a canbus.frame object
 * @method canbus.slcan._parseFrame
 * @param {String} string to parse into frame
 * @private
 */
canbus.slcan.prototype._parseFrame = function(str) {
    var is_ext_id;
    var is_remote;
    var id;
    var dlc;
    var data = []

    // get frame type from first character
    if (str[0] === 't') {
        is_ext_id = false;
        is_remote = false;
    } else if (str[0] === 'r') {
        is_ext_id = false;
        is_remote = true;
    } else if (str[0] === 'T') {
        is_ext_id = true;
        is_remote = false;
    } else if (str[0] === 'R') {
        is_ext_id = true;
        is_remote = true;
    } else {
        throw "Invalid slcand frame! (bad frame type char)";
    }
    console.log(str);

    // slice the correct number of bits depending on id length
    id = (is_ext_id ? str.substr(1, canbus.slcan.EXT_ID_LEN) :
          str.substr(1, canbus.slcan.STD_ID_LEN));
    // convert from hex string to number
    id = Number("0x" + id);
    if (isNaN(id)) {
        throw "Invalid ID value";
    }

    // data length code is single digit after id
    dlc = (is_ext_id ? str.substr(1 + canbus.slcan.EXT_ID_LEN, 1) :
           str.substr(1 + canbus.slcan.STD_ID_LEN, 1));
    dlc = Number(dlc);
    // check dlc is valid
    if (isNaN(dlc) || dlc < 0 || dlc > 8) {
        throw "Invalid DLC value"
    }

    for (var i = 0; i < dlc; i++) {
        // compute the position of the first char of the byte to read
        var pos = (is_ext_id ? (2 + canbus.slcan.EXT_ID_LEN + i * 2) :
                   (2 + canbus.slcan.STD_ID_LEN + i * 2));
        var b = Number("0x" + str.substr(pos, 2));
        if (isNaN(b)) {
            throw "Invalid data byte at position " + i;
        }
        data.push(b);
    }

    var res = new canbus.frame(id)
    res.id_ext_id = is_ext_id;
    res.is_remote = is_remote;
    res.dlc = dlc;
    res.data = data;

    return res;
}

/**
 * Helper function to pack a canbus.frame object into a slcan string
 * @method canbus.slcan._packFrame
 * @param {canbus.frame} frame to pack into string
 * @private
 */
canbus.slcan.prototype._packFrame = function(frame) {
    // set frame as data or remote
    var res = frame.is_remote ? 'r' : 't';
    // set frame as standard or extended id
    if (frame.is_ext_id) {
        res = res.toUpperCase();
    }

    // add the identifier as hex, padded to the id length
    var id_str = "0000000" + frame.id.toString(16);

    if (frame.is_ext_id) {
        res = res + id_str.substr(id_str.length - canbus.slcan.EXT_ID_LEN);
    } else {
        res = res + id_str.substr(id_str.length - canbus.slcan.STD_ID_LEN);
    }

    // add the data length code
    res = res + frame.dlc.toString();

    // add the data bytes
    for (var i = 0; i < frame.dlc; i++) {
        // add byte as hex string, padded to 2 characters
        var byte_str = "0" + frame.data[i].toString(16).toUpperCase();
        res = res + byte_str.substr(byte_str.length - 2);
    }

    // terminate with \r
    res = res + "\r";
    return res;
}
