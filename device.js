'use strict';

const Homey = require('homey');
const net = require('net');
const Modbus = require('jsmodbus');

const RETRY_INTERVAL = 60 * 1000;
const OPERATION_MODE_ADDRESS = 1500; // Address for Operation_mode
const TARGET_TEMPERATURE_ADDRESS = 1501; // Use address 1501 for target_temperature
const MEASURE_TEMPERATURE_ADDRESS = 583; // Use address 583 for measure_temperature

module.exports = class ModbusDevice extends Homey.Device {
  _modbusOptions = {
    host: this.getSetting('ip'),
    port: this.getSetting('port'),
    unitId: this.getSetting('id'),
    timeout: 5000,
    autoReconnect: true,
    logLabel: 'ISG modbus',
    logLevel: 'error',
    logEnabled: true,
  };

  async onInit() {
    this.log('Device init: ' + this.getName() + ' ID: ' + this.getData().id);

    this.log('Modbus settings:', this._modbusOptions);

    this.setWarning(this.homey.__("device.modbus.device_info"));

    this._settings = this.getSettings();
    this._settings.connection = this._settings.connection || "keep"; // Ensure connection setting is defined
    this._socketConnected = false;
    this._socket = new net.Socket();

    this.log('Socket settings:', {
      host: this._settings.ip,
      port: this._settings.port,
      unitID: this._settings.id,
    });

    const option = {
      'host': this._settings.ip,
      'port': this._settings.port,
      'unitID': this._settings.id,
      'timeout': 5000,
      'autoReconnect': true,
      'logLabel': 'Stiebel Eltron ISG',
      'logLevel': 'error',
      'logEnabled': true
    };

    this.log('Option settings:', option);

    // Create a new Modbus TCP client using the socket and unitId
    this._client = new Modbus.client.TCP(this._socket, this._modbusOptions.unitId);
    this._socket.setKeepAlive(true);
    this._socket.setMaxListeners(99);

    this._socket.on('end', () => {
      this.log("Socket ended.");
    });

    this._socket.on('connect', () => {
      this.log("Socket connected.");
      this._socketConnected = true; // Update socket connection status
    });

    this._socket.on('timeout', () => {
      this.log("Socket timeout.");
      this._socket.end();
      if (this._settings.connection === 'keep') {
        this.connectDevice().catch((error) => { this.log("Error reconnecting on socket.on('timeout'): ", error.message); });
      }
    });

    this._socket.on('error', (error) => {
      this.log("Socket error: ", error.message);
    });

    this._socket.on('close', (error) => {
      this.log("Socket closed.");
      this._socketConnected = false;
      if (this._settings.connection === 'keep') {
        this.connectDevice().catch((error) => { this.log("Error reconnecting on socket.on('close'): ", error.message); });
      }
    });

    // Connect to device
    // wait for slave device init
    await this.delay(2000);

    this.log(this._settings);
    this.log(this._settings.connection);

    if (this._settings.connection === 'keep' && this._socket) {
      this.log("KeepAlive option set. Reconnecting...");
      await this.connectDevice();
    } else {
      this.log("KeepAlive option not set. Don't reconnect.");
    }

    // Start the polling interval
    this.startPolling();

    // Register capability listener for target_temperature
    this.registerCapabilityListener('target_temperature', async (value) => {
      this.log('Received change for target_temperature:', value);
      this.log('Modbus register to write to is:', TARGET_TEMPERATURE_ADDRESS);

      // Convert the value to a 16-bit integer using scale factor 10
      const valueToWrite = Math.round(value * 10); // Scale factor 10
      this.log(`Converted value to write (scaled): ${valueToWrite}`);

      // Ensure the value is within the 16-bit integer range
      if (valueToWrite < -32768 || valueToWrite > 32767) {
        this.error(`Value ${valueToWrite} is out of 16-bit integer range`);
        return;
      }

      // Log the value and address being written
      this.log(`Writing value ${valueToWrite} to target temperature register at address ${TARGET_TEMPERATURE_ADDRESS}`);

      // Write the new value to the Modbus register using fc6 (Write Single Register)
      try {
        const result = await this._client.writeSingleRegister(TARGET_TEMPERATURE_ADDRESS, valueToWrite);
        this.log(`Successfully written value ${valueToWrite} to target temperature register ${TARGET_TEMPERATURE_ADDRESS}`);

        // Read back the value to ensure it's correctly written and update the UI
        await this.updateTargetTemperature();
      } catch (error) {
        this.error(`Error writing to target temperature register: ${error.message}`);
        this.log(`Modbus Exception Response:`, error.response);
      }
    });

    // Register capability listener for Operation_mode
    this.registerCapabilityListener('Operation_mode', async (value) => {
      this.log('Changes to Operation_mode:', value);
      this.log('Modbus register to write to is:', OPERATION_MODE_ADDRESS);

      // Read the current value of the holding register
      try {
        const currentRegister = await this._client.readHoldingRegisters(OPERATION_MODE_ADDRESS, 1);
        const currentValue = currentRegister.response._body.valuesAsBuffer.readUInt16BE(0);
        this.log(`Current value in register ${OPERATION_MODE_ADDRESS} is: ${currentValue}`);
      } catch (error) {
        this.error(`Error reading current value from operation mode register: ${error.message}`);
        return;
      }

      // Add a delay of 2 seconds
      await this.delay(2000);
      this.log('delay2000ms');

      // Convert the value to a 16-bit integer
      const valueToWrite = parseInt(value, 10);
      this.log(`Converted value to write: ${valueToWrite}`);

      // Log the value and address being written
      this.log(`Writing value ${valueToWrite} to operation mode register at address ${OPERATION_MODE_ADDRESS}`);

      // Write the new value to the Modbus register using fc6 (Write Single Register)
      try {
        const result = await this._client.writeSingleRegister(OPERATION_MODE_ADDRESS, valueToWrite);
        this.log(`Successfully written value ${valueToWrite} to operation mode register ${OPERATION_MODE_ADDRESS}`);
      } catch (error) {
        this.error(`Error writing to operation mode register: ${error.message}`);
        this.log(`Modbus Exception Response:`, error.response);
      }
    });
  }

  async connectDevice() {
    if (!this._socket) {
      return;
    }
    return new Promise((resolve, reject) => {
      this.log('Device connect: ' + this.getName() + ' to IP ' + this._modbusOptions.host + ' port ' + this._modbusOptions.port + ' ID ' + this._modbusOptions.unitId);

      const errorHandler = (error) => {
        this._socket.removeListener("connect", connectHandler);
        reject(error);
      }

      const connectHandler = () => {
        this.log('Connected successfully.');
        this._socketConnected = true;
        this._socket.removeListener("error", errorHandler);
        resolve();
      }

      if (!this._socketConnected) {
        this._socket.once("error", errorHandler);
        this._socket.connect(this._modbusOptions.port, this._modbusOptions.host, connectHandler);
      } else {
        this.log("Already connected.");
        resolve();
      }
    });
  }

  async disconnectDevice() {
    if (!this._socket) {
      return;
    }
    return new Promise((resolve, reject) => {
      this.log('Device disconnected: ' + this.getName());

      const errorHandler = (error) => {
        this._socket.removeListener("close", disconnectHandler);
        reject(error);
      }

      const disconnectHandler = () => {
        this.log('Disconnected successfully.');
        this._socketConnected = false;
        this._socket.removeListener("error", errorHandler);
        resolve();
      }

      if (this._socketConnected) {
        this._socket.once("error", errorHandler);
        this._socket.end(disconnectHandler);
      } else {
        this.log("Not connected.");
        resolve();
      }
    });
  }

  async reconnectDevice() {
    this.log('Device reconnected: ' + this.getName());
    try {
      await this.disconnectDevice();
    } catch (error) { }

    if (this._settings.connection === 'keep' && this._socket) {
      this.log("KeepAlive option set. Reconnecting...");
      await this.connectDevice();
    } else {
      this.log("KeepAlive option not set. Don't reconnect.");
    }
  }

  getSocket() {
    return this._socket;
  }

  async onSettings({ newSettings, changedKeys }) {
    if (newSettings && (newSettings.ip || newSettings.port)) {
      try {
        this.log("IP address or port changed. Reconnecting...");
        this._modbusOptions.host = newSettings.ip;
        this._modbusOptions.port = newSettings.port;
        this._modbusOptions.unitId = newSettings.id;
        this._settings = newSettings;
        this.log("KeepAlive option set. Reconnecting...");

        this._client = new Modbus.client.TCP(this._socket, this._modbusOptions.unitId);
        // Disconnect
        try {
          await this.disconnectDevice();
        } catch (error) {
          this.log("Error disconnecting: ", error.message);
        }
        // Connect if device was not connected before to init connection
        if (newSettings.connection === 'keep') {
          await this.connectDevice();
          this.log('Reconnected successfully.');
        } else {
          this.log("KeepAlive option not set. Don't reconnect.");
        }

      } catch (error) {
        this.log('Error reconnecting: ', error.message);
        throw error;
      }
    }
  }

  async updateOperationMode() {
    try {
      const result = await this._client.readHoldingRegisters(OPERATION_MODE_ADDRESS, 1);
      const currentValue = result.response._body.valuesAsBuffer.readUInt16BE(0);
      this.log(`Polled value from register ${OPERATION_MODE_ADDRESS} is: ${currentValue}`);

      // Update the capability value if it has changed
      const currentCapabilityValue = this.getCapabilityValue('Operation_mode');
      if (currentCapabilityValue !== currentValue.toString()) { // Convert to string
        this.log(`Updating capability 'Operation_mode' to: ${currentValue}`);
        this.setCapabilityValue('Operation_mode', currentValue.toString());
      }
    } catch (error) {
      this.error(`Error polling value from operation mode register: ${error.message}`);
    }
  }

  async updateTargetTemperature() {
    try {
      this.log('Polling target_temperature from register:', TARGET_TEMPERATURE_ADDRESS);
      const result = await this._client.readHoldingRegisters(TARGET_TEMPERATURE_ADDRESS, 1); // Use fc03
      const currentValue = result.response._body.valuesAsBuffer.readUInt16BE(0) / 10; // Scale factor 10
      this.log(`Polled value from register ${TARGET_TEMPERATURE_ADDRESS} is: ${currentValue}`);

      // Log the value that will be shown as target temperature
      this.log(`Updating capability 'target_temperature' with value: ${currentValue}`);

      // Update the capability value if it has changed
      const currentCapabilityValue = this.getCapabilityValue('target_temperature');
      if (currentCapabilityValue !== currentValue) {
        this.log(`Updating capability 'target_temperature' to: ${currentValue}`);
        this.setCapabilityValue('target_temperature', currentValue);
      }
    } catch (error) {
      this.error(`Error polling value from target temperature register: ${error.message}`);
      this.error('Full error details:', error);
    }
  }

  // Update de gemeten temperatuur
  async updateMeasureTemperature() {
    try {
      this.log('Polling measure_temperature from register:', MEASURE_TEMPERATURE_ADDRESS);
      const result = await this._client.readInputRegisters(MEASURE_TEMPERATURE_ADDRESS, 1); // Use fc04
      const currentValue = result.response._body.valuesAsBuffer.readUInt16BE(0) / 10; // Apply scale factor 10
      this.log(`Polled value from register ${MEASURE_TEMPERATURE_ADDRESS} is: ${currentValue}`);

      // Update de capability value als deze is gewijzigd
      const currentCapabilityValue = this.getCapabilityValue('measure_temperature');
      if (currentCapabilityValue !== currentValue) {
        this.log(`Updating capability 'measure_temperature' to: ${currentValue}`);
        this.setCapabilityValue('measure_temperature', currentValue);
      }
    } catch (error) {
      this.error(`Error polling value from measure temperature register: ${error.message}`);
      this.error('Full error details:', error);
    }
  }

  processOperationMode(operationModeValue) {
    const enumValues = this.getCapabilityOptions('Operation_mode').values;
    let enumValue = enumValues.find(value => value.id === operationModeValue)?.id;

    if (enumValue === undefined) {
      this.error('wrong operation mode value:', operationModeValue);
      return;
    }

    this.setCapabilityValue('Operation_mode', enumValue);
  }

  getCapabilityOptions(capability) {
    const driver = this.homey.drivers.getDriver('stiebel-heatpump');
    this.log(`Getting capability options for ${capability}`);
    return driver.manifest.capabilitiesOptions[capability] || {};
  }

  startPolling() {
    const capabilities = [
      'measure_temperature.inputregister.1',
      'measure_temperature.inputregister.2',
      'measure_temperature.inputregister.3',
      'measure_temperature.inputregister.4',
      'measure_temperature.inputregister.5',
      'measure_temperature.inputregister.6',
      'measure_temperature.inputregister.7'
    ];

    this.pollingInterval = setInterval(async () => {
      await this.updateOperationMode();
      await this.updateTargetTemperature();
      await this.updateMeasureTemperature();
      setTimeout(() => {
        Promise.all(capabilities.map(capability => {
          const options = this.getCapabilityOptions(capability);
          return this._client.readInputRegisters(options.address, 1).then(result => {
            const value = result.response._body._valuesAsBuffer.readInt16BE() / options.scale;
            this.setCapabilityValue(capability, value);
          });
        })).then(() => {
          this.log('All values updated');
        }).catch((error) => {
          this.log(error);
        });
      }, 5000);
    }, 5000);
  }

  onAdded() {
    this.log('device added: ', this.getData().id);
  }

  onDeleted() {
    this.log('device deleted:', this.getData().id);
    this._socket.end();
  }

  onUninit() {
    this.log('Uninit device: ', this.getData().id);
    this.disconnectDevice();
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
};
