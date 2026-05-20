// worker.js

/**
 * 系統常數設定
 */
const CONSTANTS = {
    LARGE_THRESHOLD: 1024,
    MARGIN_LARGE: 64,
    MARGIN_SMALL: 32,
    MARGIN_LARGE_NEW: 192,
    MARGIN_SMALL_NEW: 96,
    LOGO_VALUE: 255.0,
    ALPHA_THRESHOLD: 0.002,
    MAX_ALPHA: 0.99,
    POSITION_SCORE_TOLERANCE: 0.05,
    POSITION_SCORE_THRESHOLD: 0.2
};

let masks = {
    small: null,
    large: null
};

// 監聽主執行緒的訊息
self.onmessage = function(e) {
    const { type, payload } = e.data;

    if (type === 'INIT_MASKS') {
        masks = payload; // { small: { width, height, alphas }, large: ... }
    } else if (type === 'PROCESS_IMAGE') {
        const { imageData, config } = payload;
        try {
            const result = removeWatermark(imageData, config);
            const watermarkRegion = result ? result.region : null;
            const appliedGain = result ? result.appliedGain : config.alphaGain;
            self.postMessage({
                type: 'PROCESS_COMPLETE',
                payload: { imageData, watermarkRegion, appliedGain },
                id: payload.id
            }, [imageData.data.buffer]); // 轉移 buffer
        } catch (err) {
            self.postMessage({
                type: 'PROCESS_ERROR',
                payload: err.message,
                id: payload.id
            });
        }
    }
};

/**
 * 執行浮水印去除的核心函式
 * 包含：選擇大小模式、定位浮水印區域、自動估算強度、套用逆向 Alpha 混合演算法
 */
function removeWatermark(imageData, config) {
    const w = imageData.width;
    const h = imageData.height;

    // 1. 決定尺寸模式
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

    // 2. 智慧偵測浮水印區域
    const region = selectWatermarkRegion(imageData, mask, mode);
    if (!region) return null;

    const posX = region.x;
    const posY = region.y;

    // 3. 處理強度增益值 (優先自動偵測)
    const data = imageData.data;
    let gain = config.alphaGain;

    if (config.autoStrength) {
        gain = estimateOptimalGain(imageData, mask, posX, posY);
    }

    // 4. 執行逆向 Alpha 混合演算法消除浮水印
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

    return { region, appliedGain: gain };
}

/**
 * 依照新舊 Gemini 浮水印邊距候選值，選出最可能的浮水印區域。
 * 目前保留舊版 64/32px 邊距，同時支援新版 192/96px 邊距。
 */
function selectWatermarkRegion(imageData, mask, mode) {
    const w = imageData.width;
    const h = imageData.height;
    const margins = mode === 'large'
        ? [CONSTANTS.MARGIN_LARGE, CONSTANTS.MARGIN_LARGE_NEW]
        : [CONSTANTS.MARGIN_SMALL, CONSTANTS.MARGIN_SMALL_NEW];

    const candidates = margins
        .map(margin => ({
            margin,
            x: w - margin - mask.width,
            y: h - margin - mask.height,
            width: mask.width,
            height: mask.height,
            score: Number.NEGATIVE_INFINITY
        }))
        .filter(region => region.x >= 0 && region.y >= 0);

    if (candidates.length === 0) return null;

    for (const candidate of candidates) {
        candidate.score = scoreWatermarkCandidate(imageData, mask, candidate);
    }

    const best = candidates.reduce((currentBest, candidate) => (
        candidate.score > currentBest.score ? candidate : currentBest
    ));
    const newerCandidate = candidates.find(candidate => (
        candidate.margin === CONSTANTS.MARGIN_LARGE_NEW ||
        candidate.margin === CONSTANTS.MARGIN_SMALL_NEW
    ));

    // 新版 Gemini 樣本會落在 192/96px 邊距；分數接近時優先使用新版位置。
    if (
        newerCandidate &&
        newerCandidate.score >= CONSTANTS.POSITION_SCORE_THRESHOLD &&
        newerCandidate.score >= best.score - CONSTANTS.POSITION_SCORE_TOLERANCE
    ) {
        return newerCandidate;
    }

    return best;
}

/**
 * 使用遮罩與影像灰階值的相關性評分，估計候選區域是否像 Gemini 星形浮水印。
 * 計算皮爾森相關係數 (Pearson Correlation Coefficient) 作為相關度指標。
 */
function scoreWatermarkCandidate(imageData, mask, region) {
    const data = imageData.data;
    const stride = imageData.width * 4;
    const sampleStep = 1;
    let sumMask = 0;
    let sumGray = 0;
    let count = 0;

    for (let my = 0; my < mask.height; my += sampleStep) {
        for (let mx = 0; mx < mask.width; mx += sampleStep) {
            const maskValue = mask.alphas[my * mask.width + mx];
            const idx = ((region.y + my) * stride) + ((region.x + mx) * 4);
            const gray = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;

            sumMask += maskValue;
            sumGray += gray;
            count++;
        }
    }

    const meanMask = sumMask / count;
    const meanGray = sumGray / count;
    let covariance = 0;
    let maskVariance = 0;
    let grayVariance = 0;

    for (let my = 0; my < mask.height; my += sampleStep) {
        for (let mx = 0; mx < mask.width; mx += sampleStep) {
            const maskDiff = mask.alphas[my * mask.width + mx] - meanMask;
            const idx = ((region.y + my) * stride) + ((region.x + mx) * 4);
            const gray = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
            const grayDiff = gray - meanGray;

            covariance += maskDiff * grayDiff;
            maskVariance += maskDiff * maskDiff;
            grayVariance += grayDiff * grayDiff;
        }
    }

    if (maskVariance <= 0 || grayVariance <= 0) return 0;
    return covariance / Math.sqrt(maskVariance * grayVariance);
}

/**
 * 估算最佳的浮水印強度增益值 (alphaGain)
 * 使用相關性最小化 (Pearson Correlation Minimization) 演算法。
 * 當強度過低，殘留的浮水印是亮色，與遮罩正相關；
 * 當強度過高，過度消除的區域變暗，與遮罩負相關。
 * 找出相關係數絕對值最小（最接近零相關）的強度，即為最佳消除增益。
 */
function estimateOptimalGain(imageData, mask, posX, posY) {
    const data = imageData.data;
    const w = imageData.width;
    const h = imageData.height;

    let bestGain = 0.5; // 預設的 fallback 值
    let minAbsCorr = Number.MAX_VALUE;

    const count = mask.width * mask.height;
    
    // 1. 計算 mask 的平均值與方差 (排除 alpha <= 0.05 的無關區域)
    let sumMask = 0;
    let validCount = 0;
    for (let i = 0; i < count; i++) {
        if (mask.alphas[i] > 0.05) {
            sumMask += mask.alphas[i];
            validCount++;
        }
    }
    
    if (validCount === 0) return 0.5;
    const meanMask = sumMask / validCount;

    let varMask = 0;
    for (let i = 0; i < count; i++) {
        if (mask.alphas[i] > 0.05) {
            const diff = mask.alphas[i] - meanMask;
            varMask += diff * diff;
        }
    }

    const reconGray = new Float32Array(count);

    // 2. 搜尋範圍從 0.1 到 1.2，以 0.02 為間距進行評估
    for (let g = 0.1; g <= 1.2; g += 0.02) {
        let sumGray = 0;

        // 還原該強度下的區域灰階亮度
        for (let my = 0; my < mask.height; my++) {
            for (let mx = 0; mx < mask.width; mx++) {
                const ix = posX + mx;
                const iy = posY + my;
                const mIdx = my * mask.width + mx;

                if (ix >= w || iy >= h) {
                    reconGray[mIdx] = 0;
                    continue;
                }

                let alpha = mask.alphas[mIdx] * g;
                if (alpha > CONSTANTS.MAX_ALPHA) alpha = CONSTANTS.MAX_ALPHA;
                const oneMinusAlpha = 1.0 - alpha;

                const idx = (iy * w + ix) * 4;
                let r = (data[idx] - alpha * CONSTANTS.LOGO_VALUE) / oneMinusAlpha;
                let gr = (data[idx + 1] - alpha * CONSTANTS.LOGO_VALUE) / oneMinusAlpha;
                let b = (data[idx + 2] - alpha * CONSTANTS.LOGO_VALUE) / oneMinusAlpha;

                // 限制在有效色彩區間 [0, 255]
                if (r < 0) r = 0; else if (r > 255) r = 255;
                if (gr < 0) gr = 0; else if (gr > 255) gr = 255;
                if (b < 0) b = 0; else if (b > 255) b = 255;

                const gray = r * 0.299 + gr * 0.587 + b * 0.114;
                reconGray[mIdx] = gray;

                if (mask.alphas[mIdx] > 0.05) {
                    sumGray += gray;
                }
            }
        }

        const meanGray = sumGray / validCount;

        // 計算協方差與圖像方差
        let covariance = 0;
        let varGray = 0;

        for (let my = 0; my < mask.height; my++) {
            for (let mx = 0; mx < mask.width; mx++) {
                const mIdx = my * mask.width + mx;
                if (mask.alphas[mIdx] > 0.05) {
                    const diffMask = mask.alphas[mIdx] - meanMask;
                    const diffGray = reconGray[mIdx] - meanGray;
                    covariance += diffMask * diffGray;
                    varGray += diffGray * diffGray;
                }
            }
        }

        if (varGray > 0 && varMask > 0) {
            const corr = covariance / Math.sqrt(varMask * varGray);
            const absCorr = Math.abs(corr);
            if (absCorr < minAbsCorr) {
                minAbsCorr = absCorr;
                bestGain = g;
            }
        }
    }

    return parseFloat(bestGain.toFixed(2));
}
