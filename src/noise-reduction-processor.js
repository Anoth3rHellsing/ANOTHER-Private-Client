// AudioWorklet processor for real-time noise reduction
// Uses spectral gating: estimates noise floor during silence,
// then attenuates frequencies below the estimated threshold.
class NoiseReductionProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.noiseProfile = new Float32Array(0);
    this.noiseProfileLength = 0;
    this.cachedNoiseFloor = 0;
    this.isCalibrating = false;
    this.calibrationFrames = 0;
    this.calibrationSum = null;
    this.enabled = false;
    this.strength = 0.85; // 0-1 attenuation strength
    // Calculate target calibration frames based on actual sample rate and buffer size
    // Target ~1 second of audio for noise profile regardless of sample rate/buffer size
    const sampleRate = (options && options.processorOptions && options.processorOptions.sampleRate) || 48000;
    const bufferSize = (options && options.processorOptions && options.processorOptions.bufferSize) || 128;
    this.targetCalibrationFrames = Math.max(30, Math.round(sampleRate / bufferSize));

    this.port.onmessage = (event) => {
      // Validate message structure to prevent crashes from malformed IPC
      if (!event.data || typeof event.data.type !== 'string') return;
      if (event.data.type === 'set-enabled') {
        this.enabled = !!event.data.value;
      } else if (event.data.type === 'calibrate') {
        this.startCalibration();
      } else if (event.data.type === 'set-strength') {
        const val = Number(event.data.value);
        if (!Number.isFinite(val)) return;
        this.strength = Math.max(0, Math.min(1, val));
      }
    };
  }

  startCalibration() {
    this.isCalibrating = true;
    this.calibrationFrames = 0;
    this.calibrationSum = null;
    this.port.postMessage({ type: 'calibrating', value: true });
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input[0] || !output || !output[0]) return true;

    const channelData = input[0];
    const outData = output[0];
    const frameSize = channelData.length;

    // Guard against zero-length buffers (can occur during stream renegotiation)
    if (frameSize === 0) return true;

    // Copy all channels
    for (let ch = 0; ch < input.length; ch++) {
      if (output[ch] && input[ch]) {
        output[ch].set(input[ch]);
      }
    }

    if (!this.enabled) return true;

    // Calibration mode: accumulate noise profile
    if (this.isCalibrating) {
      if (!this.calibrationSum || this.calibrationSum.length !== frameSize) {
        this.calibrationSum = new Float32Array(frameSize);
      }
      for (let i = 0; i < frameSize; i++) {
        this.calibrationSum[i] += Math.abs(channelData[i]);
      }
      this.calibrationFrames++;
      if (this.calibrationFrames >= this.targetCalibrationFrames) { // ~1 second at actual sample rate
        const profileLen = this.calibrationSum.length;
        this.noiseProfile = new Float32Array(profileLen);
        let floorSum = 0;
        for (let i = 0; i < profileLen; i++) {
          const val = (this.calibrationSum[i] / this.calibrationFrames) * 2.5;
          this.noiseProfile[i] = val;
          floorSum += val;
        }
        // Cache values for zero-allocation hot path
        this.noiseProfileLength = profileLen;
        this.cachedNoiseFloor = floorSum / profileLen;
        this.isCalibrating = false;
        this.calibrationSum = null;
        this.port.postMessage({ type: 'calibrating', value: false });
        this.port.postMessage({ type: 'calibrated', value: true });
      }
      return true;
    }

    // Apply noise gate if we have a profile (optimized: no allocations in hot path)
    if (this.noiseProfileLength > 0) {
      // Fast RMS approximation using absolute mean (cheaper than sqrt of sum-of-squares)
      let absSum = 0;
      for (let i = 0; i < frameSize; i++) {
        absSum += outData[i] < 0 ? -outData[i] : outData[i];
      }
      const rms = absSum / frameSize;

      // Use cached noise floor to avoid per-frame profile averaging
      const threshold = this.cachedNoiseFloor * 3;
      const kneeWidth = threshold * 0.5;

      let gain;
      if (kneeWidth <= 0) {
        // Degenerate case: noise floor is zero or near-zero, pass through
        gain = 1;
      } else if (rms < threshold - kneeWidth) {
        gain = 1 - this.strength;
      } else if (rms > threshold + kneeWidth) {
        gain = 1;
      } else {
        const x = (rms - threshold + kneeWidth) / (2 * kneeWidth);
        gain = (1 - this.strength) + this.strength * x;
      }

      // Clamp gain to valid range to prevent NaN/Infinity propagation
      if (!Number.isFinite(gain) || gain < 0) gain = 0;
      if (gain > 1) gain = 1;

      // Apply gain
      for (let i = 0; i < frameSize; i++) {
        outData[i] *= gain;
      }
    }

    return true;
  }
}

registerProcessor('noise-reduction-processor', NoiseReductionProcessor);