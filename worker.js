// worker.js

const CONSTANTS = {
    LARGE_THRESHOLD: 1024,
    MARGIN_LARGE: 64,
    MARGIN_SMALL: 32,
    LOGO_VALUE: 255.0,
    ALPHA_THRESHOLD: 0.002,
    MAX_ALPHA: 0.99
};

let masks = {
    small: null,
    large: null
};

// Listen for messages from main thread
self.onmessage = function(e) {
    const { type, payload } = e.data;

    if (type === 'INIT_MASKS') {
        masks = payload; // { small: { width, height, alphas }, large: ... }
    } else if (type === 'PROCESS_IMAGE') {
        const { imageData, config } = payload;
        try {
            removeWatermark(imageData, config);
            self.postMessage({
                type: 'PROCESS_COMPLETE',
                payload: { imageData },
                id: payload.id
            }, [imageData.data.buffer]); // Transfer buffer back
        } catch (err) {
            self.postMessage({
                type: 'PROCESS_ERROR',
                payload: err.message,
                id: payload.id
            });
        }
    }
};

function removeWatermark(imageData, config) {
    const w = imageData.width;
    const h = imageData.height;

    // 1. Determine configuration
    let mode = config.forceMode;
    if (mode === 'auto') {
        if (w > CONSTANTS.LARGE_THRESHOLD && h > CONSTANTS.LARGE_THRESHOLD) {
            mode = 'large';
        } else {
            mode = 'small';
        }
    }

    const mask = mode === 'large' ? masks.large : masks.small;
    if (!mask) {
        throw new Error('Masks not loaded yet');
    }

    const margin = mode === 'large' ? CONSTANTS.MARGIN_LARGE : CONSTANTS.MARGIN_SMALL;
    const posX = w - margin - mask.width;
    const posY = h - margin - mask.height;

    if (posX < 0 || posY < 0) return;

    // 2. Process
    const data = imageData.data;
    const gain = config.alphaGain;

    for (let my = 0; my < mask.height; my++) {
        for (let mx = 0; mx < mask.width; mx++) {
            const iy = posY + my;
            const ix = posX + mx;

            if (ix >= w || iy >= h) continue;

            const mIdx = my * mask.width + mx;
            let alpha = mask.alphas[mIdx] * gain;

            if (alpha < CONSTANTS.ALPHA_THRESHOLD) continue;
            if (alpha > CONSTANTS.MAX_ALPHA) alpha = CONSTANTS.MAX_ALPHA;

            const oneMinusAlpha = 1.0 - alpha;
            const idx = (iy * w + ix) * 4;

            for (let c = 0; c < 3; c++) {
                const currentVal = data[idx + c];
                let original = (currentVal - alpha * CONSTANTS.LOGO_VALUE) / oneMinusAlpha;
                if (original < 0) original = 0;
                if (original > 255) original = 255;
                data[idx + c] = original;
            }
        }
    }
}
