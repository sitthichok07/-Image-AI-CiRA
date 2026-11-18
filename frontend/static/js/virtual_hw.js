/**
 * Virtual Hardware Controller:
 * Handles 3-tier Tower Lamp visual effects, Cyber Toggle Switches, and Web Audio API synthesized 24V Buzzer
 */

class VirtualHardware {
  constructor() {
    this.audioCtx = null;
    this.oscillator = null;
    this.gainNode = null;
    this.isBuzzerSounding = false;
    this.soundEnabled = true;

    // DOM Elements - Lamps
    this.lampRed = document.getElementById("lampRed");
    this.lampYellow = document.getElementById("lampYellow");
    this.lampGreen = document.getElementById("lampGreen");

    // Switches
    this.switchBuzzer = document.getElementById("switchBuzzer");
    this.switchRed = document.getElementById("switchRed");
    this.switchYellow = document.getElementById("switchYellow");
    this.switchGreen = document.getElementById("switchGreen");

    // PLC Terminals
    this.relayCh1 = document.getElementById("relayCh1");
    this.relayCh2 = document.getElementById("relayCh2");
    this.relayCh3 = document.getElementById("relayCh3");
    this.relayCh4 = document.getElementById("relayCh4");

    this.plcRow1 = document.getElementById("plcRow1");
    this.plcRow2 = document.getElementById("plcRow2");
    this.plcRow3 = document.getElementById("plcRow3");
    this.plcRow4 = document.getElementById("plcRow4");

    // Internal virtual switch states
    this.states = {
      buzzer: false,
      red: false,
      yellow: true,
      green: false
    };

    // Explicitly sync DOM to initial states immediately
    this.setChannelState("buzzer", false);
    this.setChannelState("red", false);
    this.setChannelState("yellow", true);
    this.setChannelState("green", false);

    // Initialize audio context on first click for browser autoplay policies
    document.addEventListener("click", () => this.initAudioContext(), { once: true });
  }

  initAudioContext() {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass();
      }
    }
  }

  updateRelays(relays) {
    if (!relays) return;

    // Green (Ch 1)
    const gOn = Boolean(relays.green);
    this.setChannelState("green", gOn);

    // Red (Ch 2)
    const rOn = Boolean(relays.red);
    this.setChannelState("red", rOn);

    // Yellow (Ch 3)
    const yOn = Boolean(relays.yellow);
    this.setChannelState("yellow", yOn);

    // Buzzer (Ch 4)
    const bOn = Boolean(relays.buzzer);
    this.setChannelState("buzzer", bOn);
  }

  setChannelState(channel, isOn) {
    this.states[channel] = isOn;

    if (channel === "green") {
      this.lampGreen?.classList.toggle("on", isOn);
      this.updateSwitchElement(this.switchGreen, isOn);
      if (this.relayCh1) this.relayCh1.textContent = isOn ? "ON" : "OFF";
      this.plcRow1?.classList.toggle("active", isOn);
    } else if (channel === "red") {
      this.lampRed?.classList.toggle("on", isOn);
      this.updateSwitchElement(this.switchRed, isOn);
      if (this.relayCh2) this.relayCh2.textContent = isOn ? "ON" : "OFF";
      this.plcRow2?.classList.toggle("active", isOn);
    } else if (channel === "yellow") {
      this.lampYellow?.classList.toggle("on", isOn);
      this.updateSwitchElement(this.switchYellow, isOn);
      if (this.relayCh3) this.relayCh3.textContent = isOn ? "ON" : "OFF";
      this.plcRow3?.classList.toggle("active", isOn);
    } else if (channel === "buzzer") {
      this.updateSwitchElement(this.switchBuzzer, isOn);
      if (this.relayCh4) this.relayCh4.textContent = isOn ? "ON" : "OFF";
      this.plcRow4?.classList.toggle("active", isOn);

      if (isOn && this.soundEnabled) {
        this.startBuzzerAudio();
      } else {
        this.stopBuzzerAudio();
      }
    }
  }

  updateSwitchElement(el, isOn) {
    if (!el) return;
    el.classList.toggle("on", isOn);
    const textEl = el.querySelector(".switch-text");
    if (textEl) {
      textEl.textContent = isOn ? "ON" : "OFF";
    }
  }

  toggleChannel(channel) {
    const nextState = !this.states[channel];
    this.setChannelState(channel, nextState);
  }

  startBuzzerAudio() {
    if (this.isBuzzerSounding || !this.soundEnabled) return;
    this.initAudioContext();
    if (!this.audioCtx) return;

    try {
      this.oscillator = this.audioCtx.createOscillator();
      this.gainNode = this.audioCtx.createGain();

      this.oscillator.type = "square";
      this.oscillator.frequency.setValueAtTime(2800, this.audioCtx.currentTime);
      this.gainNode.gain.setValueAtTime(0.08, this.audioCtx.currentTime);

      this.oscillator.connect(this.gainNode);
      this.gainNode.connect(this.audioCtx.destination);
      this.oscillator.start();
      this.isBuzzerSounding = true;
    } catch (e) {
      console.warn("Buzzer audio error:", e);
    }
  }

  stopBuzzerAudio() {
    if (!this.isBuzzerSounding) return;
    try {
      if (this.oscillator) {
        this.oscillator.stop();
        this.oscillator.disconnect();
        this.oscillator = null;
      }
    } catch (e) {}
    this.isBuzzerSounding = false;
  }
}

// Global instance
window.vHw = new VirtualHardware();

// Global handler for UI switch pills
window.toggleVirtualSwitch = function(channel) {
  if (window.vHw) {
    window.vHw.toggleChannel(channel);
  }
};
