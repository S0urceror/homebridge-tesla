require("@babel/polyfill");
import { ClimateState, Vehicle, VehicleState, VehicleData } from "./util/types";
import { wait } from "./util/wait";
import api from "./util/api";
import { lock } from "./util/mutex";
import callbackify from "./util/callbackify";

const util = require("util");
const tesla = require("teslajs");

let Service: any, Characteristic: any;

export default function(homebridge: any) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerAccessory("homebridge-tesla", "Tesla", TeslaAccessory);
}

class TeslaAccessory {
  // From config.
  log: Function;
  name: string;
  trunk: string | null;
  frunk: string | null;
  charge: string | null;
  climate: string | null;
  chargePort: string | null;
  vin: string;
  username: string | null;
  password: string | null;
  waitMinutes: number;
  authToken: string | null;
  home: string | null;
  home_lat: number | 0;
  home_long: number | 0;

  // Runtime state.
  vehicleID: string | undefined;

  // Services exposed.
  lockService: any;
  trunkService: any;
  frunkService: any;
  chargePortService: any;
  climateService: any;
  chargeService: any;
  homeService: any;

  constructor(log, config) {
    this.log = log;
    this.name = config["name"];
    this.trunk = config["trunk"];
    this.frunk = config["frunk"];
    this.charge = config["charge"];
    this.climate = config["climate"];
    this.chargePort = config["chargePort"];
    this.vin = config["vin"];
    this.username = config["username"];
    this.password = config["password"];
    this.waitMinutes = config["waitMinutes"] || 1; // default to one minute.
    this.authToken = config["authToken"];
    this.home = config["home"];
    this.home_lat = +config["home_lat"];
    this.home_long = +config["home_long"];

    const lockService = new Service.LockMechanism(this.name, "vehicle");
    lockService
      .getCharacteristic(Characteristic.LockCurrentState)
      .on("get", callbackify(this.getLockCurrentState));
    lockService
      .getCharacteristic(Characteristic.LockTargetState)
      .on("get", callbackify(this.getLockTargetState))
      .on("set", callbackify(this.setLockTargetState));
    this.lockService = lockService;

    const climateService = new Service.Switch(this.climate, "climate");
    climateService
      .getCharacteristic(Characteristic.On)
      .on("get", callbackify(this.getClimateOn))
      .on("set", callbackify(this.setClimateOn));
    this.climateService = climateService;

    if (this.trunk) {
      // Enable the rear trunk lock service if requested. Use the name given
      // in your config.
      const trunkService = new Service.LockMechanism(this.trunk, "trunk");
      trunkService
        .getCharacteristic(Characteristic.LockCurrentState)
        .on("get", callbackify(this.getTrunkCurrentState));
      trunkService
        .getCharacteristic(Characteristic.LockTargetState)
        .on("get", callbackify(this.getTrunkTargetState))
        .on("set", callbackify(this.setTrunkTargetState));
      this.trunkService = trunkService;
    }

    if (this.frunk) {
      // Enable the front trunk lock service if requested. Use the name given
      // in your config.
      const frunkService = new Service.LockMechanism(this.frunk, "frunk");
      frunkService
        .getCharacteristic(Characteristic.LockCurrentState)
        .on("get", callbackify(this.getFrunkCurrentState));
      frunkService
        .getCharacteristic(Characteristic.LockTargetState)
        .on("get", callbackify(this.getFrunkTargetState))
        .on("set", callbackify(this.setFrunkTargetState));
      this.frunkService = frunkService;
    }

    if (this.chargePort) {
      // Enable the charge port trunk lock service if requested. Use the name given
      // in your config.
      const chargePortService = new Service.LockMechanism(
        this.chargePort,
        "chargePort",
      );
      chargePortService
        .getCharacteristic(Characteristic.LockCurrentState)
        .on("get", callbackify(this.getChargePortCurrentState));
      chargePortService
        .getCharacteristic(Characteristic.LockTargetState)
        .on("get", callbackify(this.getChargePortTargetState))
        .on("set", callbackify(this.setChargePortTargetState));
      this.chargePortService = chargePortService;
    }
    if (this.charge) {
      // Enable the charge service if requested. Use the name given
      // in your config.
      const chargeService = new Service.Switch(this.charge, "charge");
      chargeService
        .getCharacteristic(Characteristic.On)
        .on("get", callbackify(this.getChargingOn))
        .on("set", callbackify(this.setChargingOn));
      this.chargeService = chargeService;
    }
    if (this.home) {
      // Enable the charge service if requested. Use the name given
      // in your config.
      const homeService = new Service.ContactSensor(this.home, "home");
      homeService
        .getCharacteristic(Characteristic.ContactSensorState)
        .on("get", callbackify(this.getHomeOn));
      this.homeService = homeService;
    }
  }

  getServices() {
    const {
      lockService,
      climateService,
      trunkService,
      frunkService,
      chargeService,
      chargePortService,
      homeService,
    } = this;
    return [
      lockService,
      climateService,
      ...(trunkService ? [trunkService] : []),
      ...(frunkService ? [frunkService] : []),
      ...(chargePortService ? [chargePortService] : []),
      ...(chargeService ? [chargeService] : []),
      ...(homeService ? [homeService] : []),
    ];
  }

  //
  // Vehicle Lock
  //

  getLockCurrentState = async () => {
    const options = await this.getOptions();

    // This will only succeed if the car is already online.
    const state: VehicleState = await api("vehicleState", options);

    return state.locked
      ? Characteristic.LockCurrentState.SECURED
      : Characteristic.LockCurrentState.UNSECURED;
  };

  getLockTargetState = async () => {
    const options = await this.getOptions();

    // This will only succeed if the car is already online.
    const state: VehicleState = await api("vehicleState", options);

    return state.locked
      ? Characteristic.LockTargetState.SECURED
      : Characteristic.LockTargetState.UNSECURED;
  };

  setLockTargetState = async state => {
    const options = await this.getOptions();

    // Wake up, this is important!
    await this.wakeUp();

    this.log("Set lock state to", state);

    if (state === Characteristic.LockTargetState.SECURED) {
      await api("doorLock", options);
    } else {
      await api("doorUnlock", options);
    }

    // We succeeded, so update the "current" state as well.
    // We need to update the current state "later" because Siri can't
    // handle receiving the change event inside the same "set target state"
    // response.
    await wait(1);

    if (state == Characteristic.LockTargetState.SECURED) {
      this.lockService.setCharacteristic(
        Characteristic.LockCurrentState,
        Characteristic.LockCurrentState.SECURED,
      );
    } else {
      this.lockService.setCharacteristic(
        Characteristic.LockCurrentState,
        Characteristic.LockCurrentState.UNSECURED,
      );
    }
  };

  //
  // Climate Switch
  //

  getClimateOn = async () => {
    const options = await this.getOptions();

    // This will only succeed if the car is already online. We don't want to
    // wake it up just to see if climate is on because that could drain battery!
    const state: ClimateState = await api("climateState", options);
    const on = state.is_auto_conditioning_on;
    return on;
  };

  setClimateOn = async on => {
    const options = await this.getOptions();

    // Wake up, this is important!
    await this.wakeUp();

    this.log("Set climate to", on);

    if (on) {
      await api("climateStart", options);
    } else {
      await api("climateStop", options);
    }
  };

  //
  // Rear Trunk
  //

  getTrunkCurrentState = async () => {
    const options = await this.getOptions();

    // This will only succeed if the car is already online. We don't want to
    // wake it up just to see if climate is on because that could drain battery!
    const state: VehicleState = await api("vehicleState", options);

    return state.rt
      ? Characteristic.LockCurrentState.UNSECURED
      : Characteristic.LockCurrentState.SECURED;
  };

  getTrunkTargetState = async () => {
    const options = await this.getOptions();

    // This will only succeed if the car is already online.
    const state: VehicleState = await api("vehicleState", options);

    return state.rt
      ? Characteristic.LockTargetState.UNSECURED
      : Characteristic.LockTargetState.SECURED;
  };

  setTrunkTargetState = async state => {
    const options = await this.getOptions();

    // Wake up, this is important!
    await this.wakeUp();

    this.log("Set trunk state to", state);

    // Now technically we are just "actuating" the state here; if you asked
    // to open the trunk, we will just "actuate" it. On the Model 3, that means
    // pop it no matter what you say - if you say "Close" it'll do nothing.
    // On the Model S/X with power liftgates, if you say "Open" or "Close"
    // it will do the same thing: "actuate" which means to just toggle it.
    await api("openTrunk", options, tesla.TRUNK);

    // We succeeded, so update the "current" state as well.
    // We need to update the current state "later" because Siri can't
    // handle receiving the change event inside the same "set target state"
    // response.
    await wait(1);

    if (state == Characteristic.LockTargetState.SECURED) {
      this.trunkService.setCharacteristic(
        Characteristic.LockCurrentState,
        Characteristic.LockCurrentState.SECURED,
      );
    } else {
      this.trunkService.setCharacteristic(
        Characteristic.LockCurrentState,
        Characteristic.LockCurrentState.UNSECURED,
      );
    }
  };

  //
  // Front Trunk
  //

  getFrunkCurrentState = async () => {
    const options = await this.getOptions();

    // This will only succeed if the car is already online. We don't want to
    // wake it up just to see if climate is on because that could drain battery!
    const state: VehicleState = await api("vehicleState", options);

    return state.ft
      ? Characteristic.LockCurrentState.UNSECURED
      : Characteristic.LockCurrentState.SECURED;
  };

  getFrunkTargetState = async () => {
    const options = await this.getOptions();

    // This will only succeed if the car is already online.
    const state: VehicleState = await api("vehicleState", options);

    return state.ft
      ? Characteristic.LockTargetState.UNSECURED
      : Characteristic.LockTargetState.SECURED;
  };

  setFrunkTargetState = async state => {
    const options = await this.getOptions();

    // Wake up, this is important!
    await this.wakeUp();

    this.log("Set frunk state to", state);

    if (state === Characteristic.LockTargetState.SECURED) {
      throw new Error("Cannot close an open frunk.");
    } else {
      await api("openTrunk", options, tesla.FRUNK);
    }

    // We succeeded, so update the "current" state as well.
    // We need to update the current state "later" because Siri can't
    // handle receiving the change event inside the same "set target state"
    // response.
    await wait(1);

    const { frunkService } = this;

    frunkService &&
      frunkService.setCharacteristic(
        Characteristic.LockCurrentState,
        Characteristic.LockCurrentState.UNSECURED,
      );
  };

  // Charge Port

  getChargePortCurrentState = async () => {
    const options = await this.getOptions();
    // This will only succeed if the car is already online.
    const state: VehicleData = await api("vehicleData", options);

    return state.charge_state.charge_port_door_open
      ? Characteristic.LockCurrentState.UNSECURED
      : Characteristic.LockCurrentState.SECURED;
  };

  getChargePortTargetState = async () => {
    const options = await this.getOptions();
    // This will only succeed if the car is already online.
    const state: VehicleData = await api("vehicleData", options);

    return state.charge_state.charge_port_door_open
      ? Characteristic.LockTargetState.UNSECURED
      : Characteristic.LockTargetState.SECURED;
  };

  setChargePortTargetState = async state => {
    const options = await this.getOptions();
    // Wake up, this is important!
    await this.wakeUp();

    this.log("Set charge port state to", state);

    if (state === Characteristic.LockTargetState.SECURED) {
      await api("closeChargePort", options);
    } else {
      await api("openChargePort", options);
    }

    // We succeeded, so update the "current" state as well.
    // We need to update the current state "later" because Siri can't
    // handle receiving the change event inside the same "set target state"
    // response.
    await wait(1);

    if (state == Characteristic.LockTargetState.SECURED) {
      this.chargePortService.setCharacteristic(
        Characteristic.LockCurrentState,
        Characteristic.LockCurrentState.SECURED,
      );
    } else {
      this.chargePortService.setCharacteristic(
        Characteristic.LockCurrentState,
        Characteristic.LockCurrentState.UNSECURED,
      );
    }
  };

  //
  // Charge - is the car charging?
  //

  getChargingOn = async () => {
    const options = await this.getOptions();

    // This will only succeed if the car is already online.
    const state: VehicleData = await api("vehicleData", options);
    const on = state.charge_state.charging_state == "Charging";
    return on;
  };

  setChargingOn = async on => {
    const options = await this.getOptions();
    // Wake up, this is important!
    await this.wakeUp();

    this.log("Set charging to", on);

    if (on) {
      await api("startCharge", options);
    } else {
      await api("stopCharge", options);
    }
  };
  //
  // Home - is the car home?
  //

  getHomeOn = async () => {
    const options = await this.getOptions();

    // This will only succeed if the car is already online.
    const state: VehicleData = await api("vehicleData", options);
    const lat = state.drive_state.latitude;
    const long = state.drive_state.longitude;
    const BB = 0.001; // bounding box of around 100m around home location
    const on =
      lat > this.home_lat - BB &&
      lat < this.home_lat + BB &&
      long > this.home_long - BB &&
      long < this.home_long + BB;
    return on;
  };
  //
  // General
  //

  getOptions = async (): Promise<{ authToken: string; vehicleID: string }> => {
    // Use a mutex to prevent multiple logins happening in parallel.
    const unlock = await lock("getOptions", 20000);

    try {
      // First login if we don't have a token.
      const authToken = await this.getAuthToken();

      // Grab the string ID of your vehicle.
      const { id_s: vehicleID } = await this.getVehicle();

      return { authToken, vehicleID };
    } finally {
      unlock();
    }
  };

  getAuthToken = async (): Promise<string> => {
    const { username, password, authToken } = this;

    // Return cached value if we have one.
    if (authToken) return authToken;

    this.log("Logging into Tesla with username/password…");
    const result = await api("login", username, password);
    const token = result.authToken;

    // Save it in memory for future API calls.
    this.log("Got a login token.");
    this.authToken = token;
    return token;
  };

  getVehicle = async () => {
    const { vin } = this;

    // Only way to do this is to get ALL vehicles then filter out the one
    // we want.
    const authToken = await this.getAuthToken();
    const vehicles: Vehicle[] = await api("allVehicles", { authToken });

    // Now figure out which vehicle matches your VIN.
    // `vehicles` is something like:
    // [ { id_s: '18488650400306554', vin: '5YJ3E1EA8JF006024', state: 'asleep', ... }, ... ]
    const vehicle = vehicles.find(v => v.vin === vin);

    if (!vehicle) {
      this.log(
        "No vehicles were found matching the VIN ${vin} entered in your config.json. Available vehicles:",
      );
      for (const vehicle of vehicles) {
        this.log("${vehicle.vin} [${vehicle.display_name}]");
      }

      throw new Error(`Couldn't find vehicle with VIN ${vin}.`);
    }

    this.log(
      `Using vehicle "${vehicle.display_name}" with state "${vehicle.state}"`,
    );

    return vehicle;
  };

  wakeUp = async () => {
    const options = await this.getOptions();

    // Send the command.
    await api("wakeUp", options);

    // Wait up to 30 seconds for the car to wake up.
    const start = Date.now();
    let waitTime = 1000;

    while (Date.now() - start < this.waitMinutes * 60 * 1000) {
      // Poll Tesla for the latest on this vehicle.
      const { state } = await this.getVehicle();

      if (state === "online") {
        // Success!
        return;
      }

      this.log("Waiting for vehicle to wake up…");
      await wait(waitTime);

      // Use exponential backoff with a max wait of 5 seconds.
      waitTime = Math.min(waitTime * 2, 5000);
    }

    throw new Error(
      `Vehicle did not wake up within ${this.waitMinutes} minutes.`,
    );
  };
}
