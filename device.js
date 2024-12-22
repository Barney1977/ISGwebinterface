'use strict';

const Homey = require('homey');
const net = require('net');
const Modbus = require('jsmodbus');
const fs = require('fs');
const path = require('path');

// Load the configurations from JSON files
const operationModeConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'Operation_mode.json'), 'utf8'));
const thermostatConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'Thermostat_mode.json'), 'utf8'));
const driverComposeConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'driver.compose.json'), 'utf8'));

const RETRY_INTERVAL = 60 * 1000;

module.exports = class ModbusDevice extends Homey.Device {
  _modbusOptions = {
    host: this.getSetting('ip'),
    port: this.getSetting('port'),
    unitId: this.getSetting('id'),
    timeout: 2500,
    autoReconnect: true,
    logLabel: 'ISG modbus',
    logLevel: 'error',
    logEnabled: true,
  };

  async onInit() {
    this.log('Device init: ' + this.getName() + ' ID: ' + this.getData().id);

    this.setWarning(this.homey.__("device.modbus.device_info"));

    this._settings = this.getSettings();
    this._settings.connection = "keep";
    this._socketConnected = false;
    this._socket = new net.Socket();

    const option = {
      'host': this.getSettings().address,
      'port': '502',
      'unitID': 1,
      'timeout': 5000,
      'autoReconnect': true,
      'logLabel': 'Stiebel Eltron ISG',
      'logLevel': 'error',
      'logEnabled': true
    };

    // Create a new Modbus TCP client using the socket and unitId
    this._client = new Modbus.client.TCP(this._socket, this._modbusOptions.unitId);
    this._socket.setKeepAlive(true);
    this._socket.setMaxListeners(99);

    this._socket.on('end', () => {
      this.log("Socket ended.");
    });

    this._socket.on('connect', () => {
      this.log("Socket connected.");
    });

    this._socket.connect(option.port, option.host);

    // Read Modbus registers periodically every 5000ms
    this.pollingInterval = setInterval(this.readModbusRegisters.bind(this), 5000); // every 5000ms
    this.log('Started timer to read registers every 5000ms');

    // Register capability listener for target temperature
    this.registerCapabilityListener('target_temperature', this.onTargetTemperatureChanged.bind(this));
  }

  async readModbusRegisters() {
    try {
      const allConfigs = { ...operationModeConfig, ...thermostatConfig, ...driverComposeConfig.capabilitiesOptions };

      for (const [key, { address, scale = 1, getable = true }] of Object.entries(allConfigs)) {
        if (!getable) continue;

        // Read one register at a time based on the address
        const response = await this._client.readInputRegisters(address, 1);
        let value = response.responseBody.valuesAsArray[0];

        // Apply the scale factor
        value /= scale;

        // Log the read value
        this.log(`Read value from register ${address}: ${value} (Key: ${key})`);

        // Process each register value based on its key
        switch (key) {
          case 'operation_mode':
            this.processOperationMode(value);
            break;
          case 'measure_temperature.inputregister.1':
          case 'measure_temperature.inputregister.2':
          case 'measure_temperature.inputregister.3':
          case 'measure_temperature.inputregister.4':
          case 'measure_temperature.inputregister.5':
          case 'measure_temperature.inputregister.6':
          case 'measure_temperature.inputregister.7':
          case 'target_temperature':
            this.setCapabilityValue(key, value);
            break;
          default:
            this.error('Invalid register key:', key);
        }
      }
    } catch (error) {
      this.error('Error reading Modbus registers:', error);
    }
  }

  async onTargetTemperatureChanged(value) {
    try {
      const { address } = thermostatConfig.target_temperature;
      const scale = 1; // Default scale if not specified
      const scaledValue = Math.round(value / scale); // Apply inverse scale factor
      await this._client.writeSingleRegister(address, scaledValue);
      this.log(`Written value ${value} (scaled: ${scaledValue}) to target temperature register ${address}`);
    } catch (error) {
      this.error('Error writing to target temperature register:', error);
    }
  }

  processOperationMode(operationModeValue) {
    // Determine the enum value based on operation mode
    const enumValues = operationModeConfig.operation_mode.values;
    let enumValue = enumValues.find(value => value.id === operationModeValue)?.id;

    if (enumValue === undefined) {
      this.error('Invalid operation mode value:', operationModeValue);
      return;
    }

    // Update the capability
    this.setCapabilityValue('operation_mode', enumValue);
  }

  onDeleted() {
    this.log('Device deleted');
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    if (this._client) {
      this._client.close();
    }
  }
};