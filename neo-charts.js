(function (root, factory) {
    'use strict';
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define(factory);
    } else {
        var api = factory();
        root.neoCharts = api;
        root.simpleChart = api; // backward compat
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var SMOOTH_STEPS = 8;
    var HEADROOM_FACTOR = 1.10;
    var ANIMATION_STAGGER = 0.05;
    var ANIMATION_STAGGER_MAX = 1.2;
    var GAUGE_ANIM_DURATION = 1000;
    var GAUGE_GAP_DEG = 30;

    var seriesDefaults = {
        title: '',
        values: [],
        labels: [],
        outputValues: [],
        color: [],
        prefix: '',
        suffix: '',
        decimals: 3
    };

    var defaults = {
        type: 'column',
        cssClass: '',
        title: {
            text: 'Neo Charts',
            subtitle: '',
            align: 'right'
        },
        layout: {
            width: '100%',
            height: '300px',
            lines: {
                number: 4
            }
        },
        gap: 2,
        fit: false,
        gauge: {
            thickness: 14,
            valueFontSize: 48
        },
        pie: {
            innerRadius: 0
        },
        bullet: {
            targets: [],
            ranges: []
        },
        funnel: {
            direction: 'vertical',
            flip: false,
            mode: 'funnel'
        },
        waterfall: {
            direction: 'horizontal'
        },
        highlight: false,
        animate: true,
        legend: true,
        gradient: true,
        smooth: false,
        theme: 'dark',
        onClick: null,
        onHover: null,
        data: {
            render: {
                empty: 'No data available.',
                stacked: false,
                threshold: []
            },
            series: []
        }
    };

    // Clone arrays and plain objects so merged configs never share references with the
    // module-level defaults (mutating config.pie/config.funnel/etc. must not leak globally).
    function cloneValue(value) {
        if (Array.isArray(value)) return value.slice();
        if (value && typeof value === 'object') return deepMerge(value, {});
        return value;
    }

    function deepMerge(target, source) {
        var result = {};
        var key;
        for (key in target) {
            if (target.hasOwnProperty(key)) {
                result[key] = cloneValue(target[key]);
            }
        }
        for (key in source) {
            if (source.hasOwnProperty(key)) {
                if (
                    source[key] && typeof source[key] === 'object' &&
                    !Array.isArray(source[key]) &&
                    target[key] && typeof target[key] === 'object' &&
                    !Array.isArray(target[key])
                ) {
                    result[key] = deepMerge(target[key], source[key]);
                } else {
                    result[key] = source[key];
                }
            }
        }
        return result;
    }

    function normalizeSeries(seriesArray) {
        return seriesArray.map(function (serie) {
            return deepMerge(seriesDefaults, serie);
        });
    }

    function toFixed3(n) {
        return n.toFixed(3);
    }

    // Single-pass string escaper: no DOM round-trip (works in Node/SSR), one allocation, and it
    // escapes quotes too since escaped output is interpolated into attribute values.
    var _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, function (m) { return _escMap[m]; });
    }

    // Coerce a value expected to be numeric before it is interpolated into an inline style,
    // so a stray string can't break out of the attribute. Falls back to `fallback` on NaN.
    function num(v, fallback) {
        var n = parseFloat(v);
        return isFinite(n) ? n : fallback;
    }

    function sanitizeClass(cls) {
        return cls.replace(/[^a-zA-Z0-9_\- ]/g, '');
    }

    var _colorRe = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d,.\s/%]+\)|[a-zA-Z]+)$/;
    function sanitizeColor(c) {
        return _colorRe.test(c) ? c : '#888';
    }

    // Brand default used internally when a series omits color (matches default palette[0])
    var DEFAULT_COLOR = '#eb453b';

    // Whitelist a CSS length/keyword for safe inline-style injection (width/height)
    var _lengthRe = /^(auto|0|[-+]?[0-9]*\.?[0-9]+(px|em|rem|%|vw|vh|vmin|vmax|ch|ex|pt|pc|cm|mm|in)?|calc\([^"<>;{}]+\))$/;
    function sanitizeLength(v, fallback) {
        v = String(v).trim();
        return _lengthRe.test(v) ? v : fallback;
    }

    // Whitelist text-align values
    function sanitizeAlign(a) {
        return (a === 'left' || a === 'center' || a === 'right') ? a : 'right';
    }

    function abbreviate(value) {
        var abs = Math.abs(value);
        if (abs >= 1e9) return (value / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
        if (abs >= 1e6) return (value / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (abs >= 1e4) return (value / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
        if (abs >= 1000) return Math.round(value).toLocaleString();
        return (+value.toFixed(3)).toString();
    }

    // Categorical palette: 20 hues at uniform OKLCH lightness/chroma (L≈0.63, C≈0.205 — vibrant but
    // not garish), the yellow band skipped (it muddies at this lightness), and the order interleaved
    // so adjacent series sit far apart on the hue wheel — neighbours never look alike. Each clears
    // 3:1 non-text contrast on the light theme (#f9f9fa) and WCAG AA on dark (#1a1a2e).
    var defaultPalette = [
        '#eb453b', '#009ab0', '#9566f5', '#669c00', '#d847a7',
        '#00a081', '#c37300', '#3d82ff', '#0090df', '#7174ff',
        '#b25ae1', '#0096c3', '#c750c6', '#00a621', '#00a366',
        '#009e93', '#009ca2', '#e65000', '#d26600', '#e1428d'
    ];

    // Subtle vertical fade applied to data fills when gradients are enabled. A light-to-transparent
    // overlay is layered on top of the solid base color, so it works for any CSS color format
    // (hex/rgb/named) with no parsing and reads as the base color lightening toward the top.
    // `angle` lets horizontal charts fade along their own axis; `gradient` (default true) gates it,
    // returning the flat color when off. Returns just the CSS value (no property), for `background:`.
    function gradientValue(color, angle, gradient) {
        if (gradient === false) return color;
        var a = angle == null ? '180deg' : angle;
        return 'linear-gradient(' + a + ',rgba(255,255,255,.18),rgba(255,255,255,0)),' + color;
    }

    function getColor(colorArray, i, angle, gradient) {
        return 'background:' + gradientValue(getColorValue(colorArray, i), angle, gradient) + ';';
    }

    // Radial sheen layered on top of the pie/donut conic-gradient — the round-chart counterpart of
    // the vertical fade, lightening from the centre outward. Prefix it before the conic-gradient
    // (empty string when gradients are disabled).
    var PIE_SHEEN = 'radial-gradient(circle closest-side,rgba(255,255,255,.16),rgba(255,255,255,0) 72%),';

    function getColorValue(colorArray, i) {
        if (colorArray.length === 0) return defaultPalette[i % defaultPalette.length];
        var raw = colorArray.length === 1 ? colorArray[0] : (colorArray[i] || defaultPalette[i % defaultPalette.length]);
        return sanitizeColor(raw);
    }

    function neoCharts(element, options) {
        var _selector = typeof element === 'string' ? element : null;
        if (typeof element === 'string') {
            element = document.querySelector(element);
        }
        if (!element) {
            console.warn('neo-charts: no element matches selector "' + _selector + '".');
            return;
        }

        var config = deepMerge(defaults, options || {});
        config.data.series = normalizeSeries(config.data.series);

        // Backward compat: 'donut' is just 'pie' with a default inner radius.
        if (config.type === 'donut') {
            config.type = 'pie';
            if (!options || !options.pie || options.pie.innerRadius == null) {
                config.pie.innerRadius = 60;
            }
        }

        // The trapezoid variant is a funnel whose silhouette has straight sides (edges interpolate
        // linearly by position) instead of following each value. It is selected via
        // funnel.mode:'trapezoid'; top-level type:'trapezoid' is a convenience alias that maps to
        // type:'funnel' + funnel.mode:'trapezoid'. Both share all funnel layout/CSS/sizing — only
        // the per-band clip-path differs, gated by isTrapezoid below.
        if (config.type === 'trapezoid') {
            config.type = 'funnel';
            config.funnel.mode = 'trapezoid';
        }
        var isTrapezoid = config.type === 'funnel' && config.funnel.mode === 'trapezoid';

        var series = config.data.series;
        var render = config.data.render;
        var type = config.type;
        // Vertical waterfall renders column-style (bars grow bottom-to-top, categories on the
        // x-axis). Horizontal (default) keeps the bar-style layout. Gated on type so bar/bullet,
        // which share the horizontal layout, are never affected.
        var waterfallVertical = config.type === 'waterfall' && config.waterfall.direction === 'vertical';
        var useGradient = config.gradient !== false;
        var pieSheen = useGradient ? PIE_SHEEN : '';
        var validTypes = ['column', 'bar', 'line', 'area', 'progress', 'waterfall', 'gauge', 'heatmap', 'treemap', 'pie', 'bullet', 'funnel', 'trapezoid'];

        // Warn on common misconfigurations. Reassign to 'bar' so classing, guidelines, sizing and
        // every downstream type check take the real bar path (not just the render switch default).
        if (validTypes.indexOf(type) === -1) {
            console.warn('neo-charts: unknown chart type "' + type + '". Falling back to bar.');
            type = 'bar';
            config.type = 'bar';
        }
        series.forEach(function (serie, idx) {
            if (serie.values.length && serie.labels.length && serie.values.length !== serie.labels.length) {
                console.warn('neo-charts: series[' + idx + '] has ' + serie.values.length + ' values but ' + serie.labels.length + ' labels. They should match.');
            }
        });
        for (var msi = 1; msi < series.length; msi++) {
            if (series[msi].values.length !== series[0].values.length) {
                console.warn('neo-charts: series[' + msi + '] has ' + series[msi].values.length + ' values but series[0] has ' + series[0].values.length + '. Extra values are ignored; missing values render as 0.');
                break;
            }
        }

        // Waterfall renders a single running total; the axis scale is derived from series[0],
        // so extra series would render against a mismatched scale. Ignore them explicitly.
        if (type === 'waterfall' && series.length > 1) {
            console.warn('neo-charts: waterfall charts support a single series; extra series are ignored.');
            series = series.slice(0, 1);
            config.data.series = series;
        }

        // Auto-generate placeholder labels ("1", "2", ...) when a series has values but no labels,
        // so a labels-omitted config renders instead of silently showing the empty state. Gauge is
        // exempt below (it never displays labels); this covers the common column/bar/line omission.
        if (type !== 'gauge') {
            series.forEach(function (serie) {
                if (serie.values.length && !serie.labels.length) {
                    serie.labels = serie.values.map(function (_, li) { return String(li + 1); });
                }
            });
        }

        // These types are proportional or cumulative and treat negative values as 0.
        var nonNegativeTypes = ['pie', 'funnel', 'treemap', 'progress'];
        if (render.stacked) nonNegativeTypes = nonNegativeTypes.concat(['column', 'bar']);
        if (nonNegativeTypes.indexOf(type) !== -1) {
            series.forEach(function (serie, idx) {
                for (var ni = 0; ni < serie.values.length; ni++) {
                    if (serie.values[ni] < 0) {
                        console.warn('neo-charts: "' + type + '" charts treat negative values as 0 (series[' + idx + '][' + ni + '] = ' + serie.values[ni] + ').');
                        break;
                    }
                }
            });
        }

        var maxValue = 0;
        var minValue = 0;
        var maxStacked = 0;

        // Compute max/min values
        series.forEach(function (serie) {
            if (!serie.values.length) return;
            for (var vi = 0; vi < serie.values.length; vi++) {
                var v = serie.values[vi];
                if (v > maxValue) maxValue = v;
                if (v < minValue) minValue = v;
            }
        });
        var valueRange = maxValue - minValue;

        // Add 10% headroom so value labels don't collide with chart edges
        function niceMax(val) {
            if (val <= 0) return val;
            var padded = val * HEADROOM_FACTOR;
            var magnitude = Math.pow(10, Math.floor(Math.log10(padded)));
            var step = magnitude / 5;
            return Math.ceil(padded / step) * step;
        }
        if (maxValue > 0 && !render.stacked && type !== 'progress') {
            maxValue = niceMax(maxValue);
            valueRange = maxValue - minValue;
        }

        // Bullet: extend max to include targets and ranges
        if (type === 'bullet') {
            var bTargets = config.bullet.targets || [];
            var bRanges = config.bullet.ranges || [];
            var bulletMax = maxValue;
            for (var bt = 0; bt < bTargets.length; bt++) {
                if (bTargets[bt] > bulletMax) bulletMax = bTargets[bt];
            }
            for (var br = 0; br < bRanges.length; br++) {
                if (bRanges[br] > bulletMax) bulletMax = bRanges[br];
            }
            if (bulletMax > maxValue) {
                maxValue = niceMax(bulletMax);
                valueRange = maxValue - minValue;
            }
        }

        // Stacked scale must exist before guidelines/axis labels are rendered (they read
        // maxStacked and their output is cached), not lazily inside the renderers.
        if (render.stacked) {
            maxStacked = getMaxSum();
        }

        function getMaxSum() {
            var sums = [];
            var result = 0;
            for (var i = 0; i < series.length; i++) {
                for (var j = 0; j < series[i].values.length; j++) {
                    sums[j] = (sums[j] || 0) + (series[i].values[j] || 0);
                    if (result < sums[j]) result = sums[j];
                }
            }
            return result;
        }

        function sizeArray(arr, useTotal) {
            var sum = arraySum(arr);
            var denom = useTotal ? (type === 'waterfall' ? niceMax(sum) : sum) : maxValue;
            if (!denom) return arr.map(function () { return 0; });
            var sizes = [];
            for (var j = 0; j < arr.length; j++) {
                sizes.push(Math.max(0, arr[j] * 100 / denom));
            }
            return sizes;
        }

        function arraySum(arr) {
            var sum = 0;
            for (var i = 0; i < arr.length; i++) sum += arr[i];
            return sum;
        }

        // Highest point the running cumulative total reaches (never below 0) — the waterfall scale.
        function runningPeak(arr) {
            var running = 0, peak = 0;
            for (var i = 0; i < arr.length; i++) {
                running += (arr[i] || 0);
                if (running > peak) peak = running;
            }
            return peak;
        }

        function effectiveRange() {
            return minValue < 0 ? valueRange : maxValue;
        }

        // Cap the total entry stagger so large datasets still finish animating in ~1.2s instead of
        // trailing for many seconds (i*0.05s uncapped means a 200-point chart takes 10s to settle).
        function delay(i) {
            var d = Math.min(i * ANIMATION_STAGGER, ANIMATION_STAGGER_MAX);
            return 'animation-delay:' + d.toFixed(2) + 's;';
        }

        // Every interactive data element carries these. tabindex makes it keyboard-reachable so
        // :focus-visible can reveal its tooltip (CSS mirrors every :hover rule); role/aria-label
        // give it a name and, when onClick is wired, button semantics for Enter/Space activation.
        var _interactive = config.onClick || config.onHover || config.highlight;
        function dataAttr(serieIdx, itemIdx) {
            var attr = ' data-nc-series="' + serieIdx + '" data-nc-index="' + itemIdx + '"';
            if (_interactive && type !== 'gauge') {
                var serie = series[serieIdx];
                var lbl = (serie && serie.labels[itemIdx] != null) ? serie.labels[itemIdx] : String(itemIdx + 1);
                var v = serie ? formatValue(serie, itemIdx) : '';
                attr += ' tabindex="0" role="' + (config.onClick ? 'button' : 'img') + '"'
                    + ' aria-label="' + escapeHtml(String(lbl) + ': ' + String(v).replace(/<[^>]*>/g, '')) + '"';
            }
            return attr;
        }

        // Column/bar renderers cycle the default palette by item index, which makes every series in a
        // grouped/stacked chart share a color (and contradicts the legend, which colors by series).
        // When there are multiple series and this one has no explicit color, key the default palette
        // by SERIES index instead — matching line/area and the legend. Single-series keeps per-item.
        function colorIndex(serie, serieIdx, itemIdx) {
            return (series.length > 1 && serie.color.length === 0) ? serieIdx : itemIdx;
        }

        function renderEmpty() {
            return '<p class="nc-empty" role="status">' + escapeHtml(render.empty) + '</p>';
        }

        function guidelineData(number) {
            // "isHorizontal" here means the value axis runs vertically (labels descend down the
            // right edge) — true for column/line/area and for a vertical waterfall (column-style).
            var isHorizontal = (type === 'column' || type === 'line' || type === 'area' || waterfallVertical);
            var hasNeg = minValue < 0;
            var waterfallScale = 0;
            if (type === 'waterfall' && series.length > 0) {
                waterfallScale = niceMax(runningPeak(series[0].values));
            }
            var scaleMax = type === 'waterfall' ? waterfallScale : (render.stacked ? maxStacked : maxValue);
            // Waterfall's axis tracks the cumulative running total, which is 0-based even when
            // individual deltas are negative — so it must not use the per-delta minValue.
            var scaleMin = (hasNeg && type !== 'waterfall') ? minValue : 0;
            var scaleRange = type === 'waterfall' ? waterfallScale : (render.stacked ? maxStacked : (hasNeg ? valueRange : maxValue));
            var pre = series.length > 0 ? escapeHtml(series[0].prefix || '') : '';
            var suf = series.length > 0 ? escapeHtml(series[0].suffix || '') : '';

            var items = [];
            for (var i = 0; i <= number; i++) {
                var frac = i / number;
                var raw, label;

                if (isHorizontal) {
                    raw = scaleMax - frac * scaleRange;
                } else {
                    raw = scaleMin + frac * scaleRange;
                }

                if (scaleRange > 0) {
                    label = pre + abbreviate(raw) + suf;
                } else {
                    label = toFixed3(isHorizontal ? (100 - frac * 100) : (frac * 100)) + '%';
                }

                items.push({ frac: frac, label: label, isFirst: i === 0, isLast: i === number });
            }
            return { items: items, isHorizontal: isHorizontal };
        }

        // Cache guidelineData per render to avoid recomputation
        var _guideCache = {};
        function getCachedGuidelineData(number) {
            if (!_guideCache[number]) _guideCache[number] = guidelineData(number);
            return _guideCache[number];
        }

        // Guideline lines only. Axis-value labels are rendered separately by renderAxisLabels into
        // .nc-yaxis/.nc-xaxis (the previous per-guideline label + its align option were unreachable
        // for every valid chart type, so both were removed).
        function renderGuidelines(number) {
            if (!number) return '';
            var data = getCachedGuidelineData(number);
            var html = '<div class="nc-guidelines">';
            for (var i = 0; i < data.items.length; i++) {
                var d = data.items[i];
                var pos = data.isHorizontal
                    ? 'top:' + toFixed3(d.frac * 100) + '%;left:0;right:0;'
                    : 'left:' + toFixed3(d.frac * 100) + '%;top:0;bottom:0;';
                var lineType = data.isHorizontal ? 'is-horizontal' : 'is-vertical';
                var edgeClass = d.isFirst ? ' is-first' : (d.isLast ? ' is-last' : '');
                html += '<div class="nc-guideline ' + lineType + edgeClass + '" style="' + pos + '"></div>';
            }
            html += '</div>';
            return html;
        }

        function renderAxisLabels(number, axis) {
            if (!number) return '';
            var data = getCachedGuidelineData(number);
            var html = '<div class="nc-' + axis + 'axis">';
            for (var i = 0; i < data.items.length; i++) {
                html += '<span class="nc-axis-label">' + data.items[i].label + '</span>';
            }
            html += '</div>';
            return html;
        }

        // True only when this index has an explicit display string; a short outputValues array
        // falls back to numeric formatting for the trailing items instead of rendering "undefined".
        function hasOutputAt(serie, i) {
            return serie.outputValues[i] !== undefined && serie.outputValues[i] !== null;
        }

        function formatValue(serie, i) {
            return hasOutputAt(serie, i)
                ? escapeHtml(String(serie.outputValues[i]))
                : (escapeHtml(serie.prefix || '') + (serie.values[i] || 0).toFixed(serie.decimals) + escapeHtml(serie.suffix || ''));
        }

        function tooltipRow(color, label, val) {
            return '<div class="nc-tooltip-row">'
                + '<span class="nc-tooltip-dot" style="background-color:' + color + '"></span>'
                + '<span class="nc-tooltip-series">' + label + '</span>'
                + '<span class="nc-tooltip-value">' + val + '</span>'
                + '</div>';
        }

        function renderTooltip(serieIdx, i) {
            var serie = series[serieIdx];
            return '<div class="nc-tooltip">'
                + '<div class="nc-tooltip-header">' + escapeHtml(serie.labels[i] || '') + '</div>'
                + tooltipRow(getColorValue(serie.color, i), escapeHtml(serie.title), formatValue(serie, i))
                + '<div class="nc-tooltip-arrow"></div>'
                + '</div>';
        }

        function renderItemContent(serieIdx, i, opts) {
            var serie = series[serieIdx];
            var hasOutput = hasOutputAt(serie, i);
            // Build the escaped value string exactly once (the previous code escaped outputValues
            // at declaration AND again at interpolation, mangling apostrophes/quotes on the label).
            var val = hasOutput
                ? escapeHtml(String(serie.outputValues[i]))
                : (escapeHtml(serie.prefix || '') + escapeHtml(String(serie.values[i] || 0)) + escapeHtml(serie.suffix || ''));
            var hideLabel = opts && opts.hideLabel;
            var hideValue = opts && opts.hideValue;

            return '<span class="nc-main">'
                + (hideLabel ? '' : '<span class="nc-label">' + escapeHtml(serie.labels[i] || '') + '</span>')
                + (hideValue ? '' : '<span class="nc-value">' + val + '</span>')
                + '</span>';
        }

        function renderThreshold(isHorizontalBar) {
            var html = '';
            // Position numeric thresholds on the SAME scale the axis/guidelines use, so a value
            // lands where its axis label predicts. guidelineData models this: stacked -> maxStacked,
            // waterfall -> cumulative sum, negative-min -> (value - min) / valueRange.
            var hasNeg = minValue < 0;
            var scaleMin = hasNeg ? minValue : 0;
            var scaleRange;
            if (type === 'waterfall' && series.length > 0) {
                scaleRange = niceMax(runningPeak(series[0].values));
            } else if (render.stacked) {
                scaleRange = maxStacked;
            } else {
                scaleRange = hasNeg ? valueRange : maxValue;
            }
            render.threshold.forEach(function (threshold) {
                var val;
                if (typeof threshold === 'string') {
                    val = parseFloat(threshold); // already a percentage
                } else {
                    val = scaleRange > 0 ? parseFloat(toFixed3((threshold - scaleMin) * 100 / scaleRange)) : 0;
                }
                if (isNaN(val)) return;
                if (isHorizontalBar) {
                    html += '<div class="nc-threshold is-vertical" style="left:' + val + '%"></div>';
                } else {
                    html += '<div class="nc-threshold is-horizontal" style="height:' + val + '%"></div>';
                }
            });
            return html;
        }

        function renderColumn() {
            var html = '';
            var count = series.length;
            if (!count) return html;

            var hasNeg = minValue < 0;
            var range = effectiveRange();

            if (hasNeg) {
                html += '<div class="nc-baseline" style="bottom:' + toFixed3((-minValue) / range * 100) + '%"></div>';
            }

            var len = series[0].values.length;
            var isGrouped = count > 1;
            for (var i = 0; i < len; i++) {
                if (isGrouped) html += '<div class="nc-group">';
                for (var idx = 0; idx < count; idx++) {
                    var val = series[idx].values[i] || 0;
                    var h = range > 0 ? toFixed3(Math.abs(val) / range * 100) : 0;
                    var style = 'height:' + h + '%;' + getColor(series[idx].color, colorIndex(series[idx], idx, i), null, useGradient) + delay(i);
                    if (hasNeg) {
                        if (val >= 0) {
                            style += 'bottom:' + toFixed3((-minValue) / range * 100) + '%;';
                        } else {
                            style += 'bottom:' + toFixed3((-minValue - Math.abs(val)) / range * 100) + '%;';
                        }
                    }
                    html += '<div class="nc-item"' + dataAttr(idx, i) + ' style="' + style + '">';
                    html += renderItemContent(idx, i, { hideLabel: true });
                    html += renderTooltip(idx, i);
                    html += '</div>';
                }
                if (isGrouped) {
                    html += '</div>';
                }
            }
            return html;
        }

        function renderStackedColumn() {
            var html = '';
            var len = series[0].values.length;

            for (var i = 0; i < len; i++) {
                var items = '';

                // Build the combined tooltip body once per category (header + a row per series)
                var tipBody = '<div class="nc-tooltip-header">' + escapeHtml(series[0].labels[i] || '') + '</div>';
                for (var s = 0; s < series.length; s++) {
                    tipBody += tooltipRow(getColorValue(series[s].color, colorIndex(series[s], s, i)), escapeHtml(series[s].title), formatValue(series[s], i));
                }

                for (var s = 0; s < series.length; s++) {
                    var serie = series[s];
                    // Clamp: a negative value would emit height:-25% which browsers drop, corrupting the stack.
                    var h = maxStacked > 0 ? Math.max(0, (serie.values[i] || 0)) * 100 / maxStacked : 0;

                    // Each segment carries the combined tooltip so it anchors to the hovered section
                    items += '<div class="nc-item"' + dataAttr(s, i) + ' style="height:' + toFixed3(h) + '%;' + getColor(serie.color, colorIndex(serie, s, i), null, useGradient) + '">';
                    items += renderItemContent(s, i, { hideLabel: true, hideValue: true });
                    items += '<div class="nc-tooltip">' + tipBody + '<div class="nc-tooltip-arrow"></div></div>';
                    items += '</div>';
                }

                html += '<div class="nc-stack"' + dataAttr(0, i) + '>' + items + '</div>';
            }
            return html;
        }

        function renderBar() {
            var html = '';
            var count = series.length;
            if (!count) return html;

            var isGrouped = count > 1;
            var hasNeg = minValue < 0;
            var range = effectiveRange();

            var len = series[0].values.length;
            for (var i = 0; i < len; i++) {
                html += isGrouped ? '<div class="nc-group">' : '';
                for (var idx = 0; idx < count; idx++) {
                    var val = series[idx].values[i] || 0;
                    var w = range > 0 ? toFixed3(Math.abs(val) / range * 100) : 0;
                    var style = 'width:' + w + '%;' + getColor(series[idx].color, colorIndex(series[idx], idx, i), '90deg', useGradient) + delay(i);
                    if (hasNeg) {
                        if (val >= 0) {
                            style += 'margin-left:' + toFixed3((-minValue) / range * 100) + '%;';
                        } else {
                            style += 'margin-left:' + toFixed3((-minValue - Math.abs(val)) / range * 100) + '%;';
                        }
                    }
                    html += '<div class="nc-item" data-nc-width="' + w + '"' + dataAttr(idx, i) + ' style="' + style + '">';
                    html += renderItemContent(idx, i, { hideLabel: true });
                    html += renderTooltip(idx, i);
                    html += '</div>';
                }
                if (isGrouped) {
                    html += '</div>';
                }
            }
            return html;
        }

        function renderStackedBar() {
            var html = '';
            var len = series[0].values.length;

            for (var i = 0; i < len; i++) {
                html += '<div class="nc-stack">';
                for (var s = 0; s < series.length; s++) {
                    var w = maxStacked > 0 ? Math.max(0, (series[s].values[i] || 0)) * 100 / maxStacked : 0;
                    html += '<div class="nc-item"' + dataAttr(s, i) + ' style="width:' + toFixed3(w) + '%;' + getColor(series[s].color, colorIndex(series[s], s, i), '90deg', useGradient) + '">';
                    html += renderItemContent(s, i, { hideLabel: true, hideValue: true });
                    html += renderTooltip(s, i);
                    html += '</div>';
                }
                html += '</div>';
            }
            return html;
        }

        // Progress: segments stack left-to-right; sizeArray already clamps negatives to 0.
        function renderHorizontalStacked(useZIndex) {
            var html = '';
            if (!series.length) return html;

            series.forEach(function (serie, idx) {
                var widths = sizeArray(serie.values, true);
                var len = serie.values.length;
                var left = 0;

                for (var i = 0; i < len; i++) {
                    var style = 'left:' + toFixed3(left) + '%;width:' + toFixed3(widths[i]) + '%;' + getColor(serie.color, i, '90deg', useGradient);
                    if (useZIndex) {
                        style += 'z-index:' + (len - i) + ';';
                    }
                    style += delay(i);
                    html += '<div class="nc-item"' + dataAttr(idx, i) + ' style="' + style + '">';
                    html += renderItemContent(idx, i, useZIndex ? {} : { hideLabel: true, hideValue: true });
                    html += renderTooltip(idx, i);
                    html += '</div>';
                    left += widths[i];
                }
            });
            return html;
        }

        // Waterfall: each bar is a signed delta drawn against the running cumulative total, scaled
        // to the peak the running total reaches (matching the axis in guidelineData). A negative
        // delta steps the total DOWN, so the bar spans [total+delta, total] and gets a class so CSS
        // can distinguish it. This replaces the old code that summed |delta| against the net sum,
        // which overflowed past 100% and made negative steps invisible.
        function renderWaterfall() {
            var html = '';
            if (!series.length) return html;
            var serie = series[0];
            var vals = serie.values;
            var len = vals.length;

            // Denominator = the highest point the running total reaches (never below 0), niceMax'd
            // for axis headroom — the same scale guidelineData uses for waterfall.
            var denom = niceMax(runningPeak(vals));
            if (!denom) return html;

            // Vertical bars are absolutely positioned, so (unlike flex column bars) they need an
            // explicit x slot. Divide the plot into `len` equal columns with a small inter-column
            // gap, matching the visual rhythm of the column chart.
            var slotPct = 100 / len;
            var barGapPct = len > 1 ? Math.min(4, slotPct * 0.2) : 0;
            var barWidthPct = slotPct - barGapPct;

            var total = 0;
            for (var i = 0; i < len; i++) {
                var delta = vals[i] || 0;
                var startTotal = total;
                total += delta;
                var lo = Math.min(startTotal, total);
                var hi = Math.max(startTotal, total);
                var start = toFixed3(Math.max(0, lo) / denom * 100);
                var extent = toFixed3(Math.max(0, hi - Math.max(0, lo)) / denom * 100);
                var neg = delta < 0 ? ' is-negative' : '';
                // Vertical: bars grow bottom-to-top (bottom/height) within an evenly-spaced x slot.
                // Horizontal: bars grow left-to-right (left/width). Both fill along a 90deg gradient.
                var pos;
                if (waterfallVertical) {
                    var slotLeft = toFixed3(i * slotPct + barGapPct / 2);
                    pos = 'left:' + slotLeft + '%;width:' + toFixed3(barWidthPct) + '%;bottom:' + start + '%;height:' + extent + '%;';
                } else {
                    pos = 'left:' + start + '%;width:' + extent + '%;';
                }
                var style = pos + getColor(serie.color, i, '90deg', useGradient) + delay(i);
                html += '<div class="nc-item' + neg + '"' + dataAttr(0, i) + ' style="' + style + '">';
                html += renderItemContent(0, i, { hideLabel: true, hideValue: true });
                html += renderTooltip(0, i);
                html += '</div>';
            }
            return html;
        }

        // Cache smoothed values per series so the initial render and the post-render positioning
        // pass share one interpolation instead of recomputing the cubic (hoisted above renderLineArea
        // and getSmoothedValues, which both read/write it, so the first pass seeds the cache).
        var _smoothCache = {};

        function interpolatePoints(values, steps) {
            var len = values.length;
            if (len < 2) return values;
            var result = [];
            for (var i = 0; i < len - 1; i++) {
                var p0 = values[Math.max(0, i - 1)];
                var p1 = values[i];
                var p2 = values[Math.min(len - 1, i + 1)];
                var p3 = values[Math.min(len - 1, i + 2)];
                for (var s = 0; s < steps; s++) {
                    var t = s / steps;
                    var t2 = t * t;
                    var t3 = t2 * t;
                    var v = 0.5 * (
                        (2 * p1) +
                        (-p0 + p2) * t +
                        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
                        (-p0 + 3 * p1 - 3 * p2 + p3) * t3
                    );
                    result.push(v);
                }
            }
            result.push(values[len - 1]);
            return result;
        }

        function renderLineArea() {
            var isArea = type === 'area';
            var html = '';
            var isSmooth = config.smooth;

            series.forEach(function (serie, idx) {
                var len = serie.values.length;
                if (len < 2) return;

                var color = getColorValue(serie.color, idx);
                var smoothVals = isSmooth ? interpolatePoints(serie.values, SMOOTH_STEPS) : serie.values;
                _smoothCache[idx] = smoothVals; // seed so positionSegments/Dots/AreaFills reuse it
                var smoothLen = smoothVals.length;

                if (isArea) {
                    html += '<div class="nc-area-fill" data-area-series="' + idx + '" style="background-color:' + color + '"></div>';
                }

                for (var si = 0; si < smoothLen - 1; si++) {
                    html += '<div class="nc-line-segment" data-series="' + idx + '" data-seg="' + si + '" style="background-color:' + color + ';' + delay(isSmooth ? Math.floor(si / SMOOTH_STEPS) : si) + '"></div>';
                }

                // Dots at original data points (positioned in post-render via positionDots)
                for (var di = 0; di < len; di++) {
                    html += '<div class="nc-dot"' + dataAttr(idx, di) + ' data-dot-series="' + idx + '" data-dot-index="' + di + '" style="border-color:' + color + ';' + delay(di) + '">';
                    html += renderTooltip(idx, di);
                    html += '</div>';
                }

            });
            return html;
        }

        function parseHexColor(hex) {
            hex = hex.replace('#', '');
            if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
            return {
                r: parseInt(hex.substring(0, 2), 16),
                g: parseInt(hex.substring(2, 4), 16),
                b: parseInt(hex.substring(4, 6), 16)
            };
        }

        function interpolateColor(rgb, t) {
            return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (0.08 + t * 0.82).toFixed(2) + ')';
        }

        // WCAG relative luminance of an sRGB channel triple (0-255).
        function relLuminance(rgb) {
            function lin(c) {
                c = c / 255;
                return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
            }
            return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
        }

        // Pick a readable text color (light vs dark) for a solid background using actual WCAG
        // contrast, not a luma threshold: whichever of white / near-black (#1c1c1e, matching the
        // CSS is-text-dark token) scores higher contrast wins. On the default palette this picks
        // dark text (4.4-5.3:1) instead of the lower-contrast white the old threshold chose.
        // Returns '' for non-hex colors so the CSS default applies.
        var _darkTextLum = relLuminance({ r: 0x1c, g: 0x1c, b: 0x1e });
        function readableTextColor(bg) {
            if (typeof bg !== 'string' || bg.charAt(0) !== '#') return '';
            var rgb = parseHexColor(bg);
            if (isNaN(rgb.r) || isNaN(rgb.g) || isNaN(rgb.b)) return '';
            var bgLum = relLuminance(rgb);
            var contrastWhite = 1.05 / (bgLum + 0.05);
            var contrastDark = (bgLum + 0.05) / (_darkTextLum + 0.05);
            return contrastDark >= contrastWhite ? 'is-text-dark' : 'is-text-light';
        }

        function renderHeatmap() {
            var html = '';
            if (!series.length) return html;

            var heatMin = Infinity;
            var heatMax = -Infinity;
            var heatCount = 0;
            series.forEach(function (serie) {
                for (var i = 0; i < serie.values.length; i++) {
                    var v = serie.values[i];
                    if (v < heatMin) heatMin = v;
                    if (v > heatMax) heatMax = v;
                    heatCount++;
                }
            });
            if (!heatCount) return renderEmpty();
            var heatRange = heatMax - heatMin;


            var cols = series[0].labels.length;
            var rows = series.length;

            // Column labels (column gap matches the grid so labels stay aligned)
            html += '<div class="nc-heatmap-col-labels" style="grid-template-columns:repeat(' + cols + ',1fr);column-gap:' + gap + 'px">';
            for (var c = 0; c < cols; c++) {
                html += '<span class="nc-heatmap-col-label">' + escapeHtml(series[0].labels[c]) + '</span>';
            }
            html += '</div>';

            // Grid
            html += '<div class="nc-heatmap-grid" style="grid-template-columns:repeat(' + cols + ',1fr);grid-template-rows:repeat(' + rows + ',1fr);gap:' + gap + 'px">';
            for (var s = 0; s < rows; s++) {
                var serie = series[s];
                // Cycle the palette per row (series index) so rows without explicit colors differ,
                // matching the documented "cycled" fallback instead of all rendering palette[0].
                var highRgb = parseHexColor(getColorValue(serie.color, serie.color.length > 1 ? 0 : s));
                for (var i = 0; i < serie.values.length; i++) {
                    var intensity = heatRange > 0 ? (serie.values[i] - heatMin) / heatRange : 0.5;
                    var cellColor = interpolateColor(highRgb, intensity);
                    var val = formatValue(serie, i);
                    var titleVal = hasOutputAt(serie, i) ? serie.outputValues[i] : ((serie.prefix || '') + serie.values[i] + (serie.suffix || ''));

                    html += '<div class="nc-heatmap-cell"' + dataAttr(s, i) + ' style="background-color:' + cellColor + '" title="' + escapeHtml(serie.title + ': ' + titleVal) + '">';
                    html += '<span class="nc-heatmap-value">' + val + '</span>';
                    html += renderTooltip(s, i);
                    html += '</div>';
                }
            }
            html += '</div>';

            // Row labels (row gap matches the grid so labels stay aligned)
            html += '<div class="nc-heatmap-row-labels" style="grid-template-rows:repeat(' + rows + ',1fr);row-gap:' + gap + 'px">';
            for (var s = 0; s < rows; s++) {
                html += '<span class="nc-heatmap-row-label">' + escapeHtml(series[s].title) + '</span>';
            }
            html += '</div>';

            return html;
        }

        function renderTreemap() {
            var html = '';
            if (!series.length) return html;

            // Collect all items from all series into a flat list
            var items = [];
            series.forEach(function (serie, sIdx) {
                for (var i = 0; i < serie.values.length; i++) {
                    items.push({
                        value: Math.max(0, serie.values[i]),
                        label: serie.labels[i],
                        color: getColorValue(serie.color, i),
                        serieIdx: sIdx,
                        itemIdx: i
                    });
                }
            });

            // Sort descending by value for better layout
            items.sort(function (a, b) { return b.value - a.value; });

            var total = 0;
            for (var i = 0; i < items.length; i++) total += items[i].value;
            if (!total) return renderEmpty();

            // Squarified treemap layout using slice-and-dice with aspect ratio optimization
            function layoutRects(items, x, y, w, h) {
                if (items.length === 0) return [];
                if (items.length === 1) {
                    return [{ item: items[0], x: x, y: y, w: w, h: h }];
                }

                var sum = 0;
                for (var i = 0; i < items.length; i++) sum += items[i].value;

                // Try splitting at each point and pick the best aspect ratio
                var isHorizontal = w >= h;
                var bestSplit = 1;
                var bestWorst = Infinity;

                var runSum = 0;
                for (var i = 0; i < items.length - 1; i++) {
                    runSum += items[i].value;
                    var frac = runSum / sum;

                    // Compute worst aspect ratio for left partition
                    var lw, lh;
                    if (isHorizontal) {
                        lw = w * frac; lh = h;
                    } else {
                        lw = w; lh = h * frac;
                    }

                    // Worst aspect ratio of individual items in left partition
                    var worstAR = 0;
                    var leftSum = runSum;
                    for (var j = 0; j <= i; j++) {
                        var itemFrac = items[j].value / leftSum;
                        var iw, ih;
                        if (isHorizontal) {
                            iw = lw; ih = lh * itemFrac;
                        } else {
                            iw = lw * itemFrac; ih = lh;
                        }
                        var ar = iw > ih ? iw / (ih || 1) : ih / (iw || 1);
                        if (ar > worstAR) worstAR = ar;
                    }

                    if (worstAR < bestWorst) {
                        bestWorst = worstAR;
                        bestSplit = i + 1;
                    }
                }

                var left = items.slice(0, bestSplit);
                var right = items.slice(bestSplit);
                var leftSum = 0;
                for (var i = 0; i < left.length; i++) leftSum += left[i].value;
                var leftFrac = leftSum / sum;

                var rects = [];
                if (isHorizontal) {
                    var lw = w * leftFrac;
                    rects = rects.concat(layoutRects(left, x, y, lw, h));
                    rects = rects.concat(layoutRects(right, x + lw, y, w - lw, h));
                } else {
                    var lh = h * leftFrac;
                    rects = rects.concat(layoutRects(left, x, y, w, lh));
                    rects = rects.concat(layoutRects(right, x, y + lh, w, h - lh));
                }
                return rects;
            }

            var rects = layoutRects(items, 0, 0, 100, 100);

            for (var i = 0; i < rects.length; i++) {
                var r = rects[i];
                var item = r.item;
                var serie = series[item.serieIdx];
                var val = formatValue(serie, item.itemIdx);

                var tmTextCls = readableTextColor(item.color);
                html += '<div class="nc-treemap-cell' + (tmTextCls ? ' ' + tmTextCls : '') + '"' + dataAttr(item.serieIdx, item.itemIdx) + ' style="'
                    + 'left:' + toFixed3(r.x) + '%;top:' + toFixed3(r.y) + '%;'
                    + 'width:' + toFixed3(r.w) + '%;height:' + toFixed3(r.h) + '%;'
                    + 'background:' + gradientValue(item.color, null, useGradient) + ';'
                    + delay(i) + '">';
                html += '<span class="nc-treemap-label">' + escapeHtml(item.label) + '</span>';
                html += '<span class="nc-treemap-value">' + val + '</span>';
                html += renderTooltip(item.serieIdx, item.itemIdx);
                html += '</div>';
            }

            return html;
        }

        function renderGauge() {
            var serie = series[0];
            // Explicit length checks, not `|| default`: a legitimate 0 for min/max/current is falsy
            // and would otherwise be silently replaced (e.g. a -100..0 gauge).
            var current = serie.values.length > 0 ? serie.values[0] : 0;
            var min = serie.values.length > 1 ? serie.values[1] : 0;
            var max = serie.values.length > 2 ? serie.values[2] : 100;
            var value = hasOutputAt(serie, 0) ? serie.outputValues[0] : current;
            var range = max - min;
            // Clamp the fill fraction to [0,1] so over-/under-range values don't paint past the arc.
            var pct = range > 0 ? Math.max(0, Math.min(1, (current - min) / range)) : 0;
            var color = sanitizeColor(serie.color.length > 0 ? serie.color[0] : DEFAULT_COLOR);
            var trackColor = 'var(--nc-border)';
            var startDeg = 180 + GAUGE_GAP_DEG;
            var arcDeg = 360 - GAUGE_GAP_DEG * 2;
            var displayStr = String(value);
            // Capture: prefix (non-numeric, sign goes with the number), number (with optional sign/commas), suffix
            var numMatch = displayStr.match(/^([^0-9+-]*)([+-]?[\d,]*\.?\d+)(.*)$/);
            var valuePrefix = numMatch ? numMatch[1] : '';
            var numStr = numMatch ? numMatch[2].replace(/,/g, '') : '';
            var valueSuffix = numMatch ? numMatch[3] : '';
            var decimals = numStr.indexOf('.') !== -1 ? numStr.split('.')[1].length : 0;

            return '<div class="nc-ring"' + dataAttr(0, 0) + ' style="background:conic-gradient(from ' + startDeg + 'deg, ' + trackColor + ' 0deg, ' + trackColor + ' ' + arcDeg + 'deg, transparent ' + arcDeg + 'deg);--gauge-color:' + color + '"'
                + ' data-start="' + startDeg + '" data-arc="' + arcDeg + '" data-pct="' + pct + '"'
                + ' data-color="' + color + '" data-track="' + trackColor + '"'
                + ' data-value-num="' + (numStr !== '' ? parseFloat(numStr) : current) + '"'
                + ' data-value-prefix="' + escapeHtml(valuePrefix) + '"'
                + ' data-value-suffix="' + escapeHtml(valueSuffix) + '"'
                + ' data-value-decimals="' + decimals + '">'
                + '</div>'
                + '<div class="nc-ring-content">'
                + '<span class="nc-label">' + escapeHtml(serie.title) + '</span>'
                + '<span class="nc-value">0' + escapeHtml(valueSuffix) + '</span>'
                + '</div>';
        }

        // Inset a slice's [start,end] edges by halfGap on each side, clamped so it never inverts.
        // A pie is a closed ring, so EVERY boundary is shared (including the 0deg/360deg seam) and
        // every slice is inset on both sides — there is no first/last special case.
        function insetSlice(start, end, halfGap) {
            var s = start + halfGap;
            var e = end - halfGap;
            if (e < s) e = s = (start + end) / 2; // collapse to a point if the gap exceeds the slice
            return { start: s, end: e };
        }

        // Conic-gradient slice boundaries are hard-edged and alias badly. Feathering each boundary
        // over a fraction of a degree lets the gradient interpolate across the seam, smoothing it
        // (a poor browser's man's antialiasing). The feather straddles the true boundary so slice
        // sizes are unchanged; it's skipped when a slice is too thin to give up the degrees.
        var PIE_AA_DEG = 0.5;

        // Build the conic-gradient color stops for a pie/donut, inserting a transparent wedge of
        // `gapDeg` degrees between adjacent slices (split symmetrically across each shared edge).
        // A single slice (or gapDeg <= 0) produces no gaps. Returns the comma-joined stop list.
        // pie treats negatives as 0 (documented, matching funnel/treemap).
        function pieVal(v) { return Math.max(0, v || 0); }

        function pieSliceStops(serie, total, gapDeg) {
            var n = serie.values.length;
            var halfGap = (n > 1 && gapDeg > 0) ? gapDeg / 2 : 0;
            var stops = [];
            var angle = 0;
            for (var i = 0; i < n; i++) {
                var sliceAngle = (pieVal(serie.values[i]) / total) * 360;
                var endAngle = angle + sliceAngle;
                var color = getColorValue(serie.color, i);
                // Feather only when the slice can spare it on both sides (and there's a neighbour).
                var aa = (n > 1 && sliceAngle > PIE_AA_DEG * 4) ? PIE_AA_DEG : 0;
                if (halfGap > 0) {
                    // Shrink the slice on both sides; the freed degrees show through as the gap.
                    var inset = insetSlice(angle, endAngle, halfGap);
                    stops.push('transparent ' + toFixed3(angle) + 'deg ' + toFixed3(inset.start) + 'deg');
                    stops.push(color + ' ' + toFixed3(inset.start) + 'deg ' + toFixed3(inset.end) + 'deg');
                    stops.push('transparent ' + toFixed3(inset.end) + 'deg ' + toFixed3(endAngle) + 'deg');
                } else {
                    // Solid core inset by `aa`; the aa-wide bands at each boundary are left for the
                    // gradient to blend this slice's colour into its neighbour's, softening the seam.
                    stops.push(color + ' ' + toFixed3(angle + aa) + 'deg ' + toFixed3(endAngle - aa) + 'deg');
                }
                angle = endAngle;
            }
            return stops.join(',');
        }

        function renderPie() {
            var html = '';
            if (!series.length) return html;

            var serie = series[0];
            var total = 0;
            for (var i = 0; i < serie.values.length; i++) {
                total += pieVal(serie.values[i]);
            }
            if (!total) return renderEmpty();

            var innerR = config.pie.innerRadius;

            // Build conic-gradient stops. The gap (px) is converted to degrees in JS once the
            // ring's rendered radius is known (see the pie sizing block); the initial render uses
            // a 0deg gap so there is no flash of mis-sized slices before sizing runs.
            var stops = pieSliceStops(serie, total, 0);

            var ringStyle = 'background:' + pieSheen + 'conic-gradient(from 0deg,' + stops + ')';
            if (innerR > 0) {
                ringStyle += ';' + donutMask(innerR);
            }

            html += '<div class="nc-pie-ring" style="' + ringStyle + '"'
                + ' data-nc-pie-total="' + total + '"'
                + '></div>';

            // Highlight overlay (shown on hover via JS)
            var hlStyle = '';
            if (innerR > 0) {
                hlStyle = ' style="' + donutMask(innerR) + '"';
            }
            html += '<div class="nc-pie-highlight"' + hlStyle + '></div>';

            // Tooltips positioned at each slice's mid-angle (outside the ring)
            var tipAngle = 0;
            for (var i = 0; i < serie.values.length; i++) {
                var pct = toFixed3(pieVal(serie.values[i]) / total * 100);
                var sliceDeg = (pieVal(serie.values[i]) / total) * 360;
                var midDeg = tipAngle + sliceDeg / 2;
                tipAngle += sliceDeg;

                // Position at ~70% radius so tooltip overlaps the slice ~30%
                var midRad = (midDeg - 90) * Math.PI / 180;
                var tipX = toFixed3(50 + 35 * Math.cos(midRad));
                var tipY = toFixed3(50 + 35 * Math.sin(midRad));

                // Arrow points toward pie center — pick the cardinal closest to center
                var tipDir;
                if (midDeg <= 45 || midDeg > 315) tipDir = 'top';
                else if (midDeg > 45 && midDeg <= 135) tipDir = 'right';
                else if (midDeg > 135 && midDeg <= 225) tipDir = 'bottom';
                else tipDir = 'left';

                html += '<div class="nc-pie-tip-item nc-tip-' + tipDir + '" data-pie-tip="' + i + '" style="display:none;left:' + tipX + '%;top:' + tipY + '%">';
                html += '<div class="nc-tooltip">';
                html += '<div class="nc-tooltip-header">' + escapeHtml(serie.labels[i]) + '</div>';
                html += tooltipRow(getColorValue(serie.color, i), formatValue(serie, i), pct + '%');
                html += '<div class="nc-tooltip-arrow"></div>';
                html += '</div>';
                html += '</div>';
            }

            return html;
        }

        function renderBullet() {
            var html = '';
            if (!series.length) return html;

            var serie = series[0];
            var targets = config.bullet.targets || [];
            var ranges = config.bullet.ranges || [];

            // Auto-generate ranges if empty
            if (!ranges.length) {
                ranges = [maxValue * 0.6, maxValue * 0.8, maxValue];
            }

            for (var i = 0; i < serie.values.length; i++) {
                var val = serie.values[i];
                var w = maxValue > 0 ? toFixed3(Math.abs(val) / maxValue * 100) : 0;
                var color = getColorValue(serie.color, i);

                html += '<div class="nc-bullet-row"' + dataAttr(0, i) + '>';

                // Qualitative ranges (largest to smallest for correct z-stacking)
                for (var r = ranges.length - 1; r >= 0; r--) {
                    var rangeW = maxValue > 0 ? toFixed3(ranges[r] / maxValue * 100) : 0;
                    var bandOpacity = toFixed3(0.04 + (r / Math.max(1, ranges.length - 1)) * 0.08);
                    html += '<div class="nc-bullet-range" style="width:' + rangeW + '%;opacity:' + bandOpacity + '"></div>';
                }

                // Actual value bar
                html += '<div class="nc-bullet-bar" style="width:' + w + '%;background-color:' + color + ';' + delay(i) + '"></div>';

                // Target marker
                if (targets[i] !== undefined && targets[i] !== null) {
                    var tPos = maxValue > 0 ? toFixed3(targets[i] / maxValue * 100) : 0;
                    html += '<div class="nc-bullet-target" style="left:' + tPos + '%"></div>';
                }

                html += renderTooltip(0, i);
                html += '</div>';
            }

            return html;
        }

        // Build a trapezoid clip-path for one funnel band.
        // startOff/endOff are the symmetric inset (%) on the leading/trailing edges.
        function funnelClip(startOff, endOff, isHorizontal) {
            var s = toFixed3(startOff);
            var sEnd = toFixed3(100 - startOff);
            var e = toFixed3(endOff);
            var eEnd = toFixed3(100 - endOff);
            if (isHorizontal) {
                // Flow left -> right: leading edge on the left (x=0), trailing on the right (x=100)
                return 'polygon(0% ' + s + '%,0% ' + sEnd + '%,100% ' + eEnd + '%,100% ' + e + '%)';
            }
            // Flow top -> bottom: leading edge on top (y=0), trailing on bottom (y=100)
            return 'polygon(' + s + '% 0%,' + sEnd + '% 0%,' + eEnd + '% 100%,' + e + '% 100%)';
        }

        function renderFunnel() {
            var html = '';
            if (!series.length) return html;

            var serie = series[0];
            var funnelMax = 0;
            for (var i = 0; i < serie.values.length; i++) {
                if (serie.values[i] > funnelMax) funnelMax = serie.values[i];
            }
            if (funnelMax <= 0) return renderEmpty();

            var isHorizontal = config.funnel.direction === 'horizontal';
            var len = serie.values.length;

            // Edge width (%) at band boundary `p` (0 = leading edge of the first band ... len =
            // trailing edge of the last band). Funnel: each boundary follows its own value, so the
            // silhouette steps with the data. Trapezoid: boundaries interpolate linearly between
            // the first and last value widths, giving perfectly straight sides regardless of the
            // middle values.
            var firstW = Math.max(0, serie.values[0]) / funnelMax * 100;
            var lastW = Math.max(0, serie.values[len - 1]) / funnelMax * 100;
            function edgeWidth(p) {
                if (isTrapezoid) {
                    return len > 0 ? firstW + (lastW - firstW) * (p / len) : firstW;
                }
                // Funnel: boundary p sits between band p-1 and band p; use value at index p
                // (clamped to the last value so the final band ends flat at its own width).
                var idx = Math.min(p, len - 1);
                return Math.max(0, serie.values[idx]) / funnelMax * 100;
            }

            // Each band is a trapezoid spanning boundaries i (leading) and i+1 (trailing).
            // Neighbouring bands share a boundary width, so the shape stays continuous.
            // The `flip` option mirrors the whole plot (wide base / reverse flow) via CSS, which
            // keeps edges aligned — see the .is-funnel-flipped rules.
            for (var i = 0; i < len; i++) {
                var w = edgeWidth(i);
                var nextW = edgeWidth(i + 1);

                var startOff = (100 - w) / 2;
                var endOff = (100 - nextW) / 2;

                var clipPath = funnelClip(startOff, endOff, isHorizontal);

                var color = getColorValue(serie.color, i);
                var displayVal = formatValue(serie, i);

                var fnTextCls = readableTextColor(color);
                html += '<div class="nc-funnel-wrap"' + dataAttr(0, i) + '>';
                html += '<div class="nc-funnel-item' + (fnTextCls ? ' ' + fnTextCls : '') + '"'
                    + ' style="background:' + gradientValue(color, isHorizontal ? '90deg' : '180deg', useGradient) + ';clip-path:' + clipPath + ';' + delay(i) + '">';
                html += '<span class="nc-funnel-label">' + escapeHtml(serie.labels[i]) + '</span>';
                html += '<span class="nc-funnel-value">' + displayVal + '</span>';
                html += '</div>';
                html += renderTooltip(0, i);
                html += '</div>';
            }

            return html;
        }

        function legendItem(color, label) {
            return '<div class="nc-legend-item">'
                + '<span class="nc-legend-dot" style="background-color:' + color + '"></span>'
                + '<span class="nc-legend-label">' + escapeHtml(label) + '</span>'
                + '</div>';
        }

        // Visually-hidden data table so screen-reader users get the actual numbers — this is the
        // non-visual fallback that makes the DOM-text architecture pay off, and the ONLY data source
        // for pie/gauge (which are pure CSS paint). Styled .nc-sr-only in the stylesheet.
        function renderSrTable() {
            if (!series.length || !series[0].values.length) return '';
            var caption = (config.title.text || (type + ' chart'));

            if (type === 'gauge') {
                var g = series[0];
                var parts = [];
                if (g.values.length > 0) parts.push('current ' + g.values[0]);
                if (g.values.length > 1) parts.push('minimum ' + g.values[1]);
                if (g.values.length > 2) parts.push('maximum ' + g.values[2]);
                return '<table class="nc-sr-only"><caption>' + escapeHtml(caption) + '</caption><tbody><tr>'
                    + '<th scope="row">' + escapeHtml(g.title || 'Value') + '</th>'
                    + '<td>' + escapeHtml(parts.join(', ')) + '</td></tr></tbody></table>';
            }

            var cats = series[0].labels;
            var html = '<table class="nc-sr-only"><caption>' + escapeHtml(caption) + '</caption><thead><tr><th scope="col">Category</th>';
            series.forEach(function (serie) {
                html += '<th scope="col">' + escapeHtml(serie.title || 'Value') + '</th>';
            });
            html += '</tr></thead><tbody>';
            for (var i = 0; i < cats.length; i++) {
                html += '<tr><th scope="row">' + escapeHtml(cats[i] || String(i + 1)) + '</th>';
                for (var s = 0; s < series.length; s++) {
                    html += '<td>' + formatValue(series[s], i) + '</td>';
                }
                html += '</tr>';
            }
            html += '</tbody></table>';
            return html;
        }

        function donutMask(innerR) {
            var r = num(innerR, 0); // coerce so a string can't break out of the mask value
            var mask = 'radial-gradient(circle closest-side,transparent ' + r + '%,#000 calc(' + r + '% + 1px))';
            return '-webkit-mask:' + mask + ';mask:' + mask;
        }

        function getCanvasChildren(canvas) {
            var children = [];
            for (var c = 0; c < canvas.children.length; c++) {
                var ch = canvas.children[c];
                if (ch.classList.contains('nc-guidelines') || ch.classList.contains('nc-threshold') || ch.classList.contains('nc-baseline')) continue;
                children.push(ch);
            }
            return children;
        }

        function renderLegend() {
            if (!config.legend || type === 'gauge' || type === 'treemap' || type === 'heatmap' || type === 'funnel' || type === 'bullet') return '';

            // Pie: always show item-level legend
            if (type === 'pie') {
                if (!series.length) return '';
                var pieSerie = series[0];
                var pieHtml = '<div class="nc-legend">';
                for (var pi = 0; pi < pieSerie.labels.length; pi++) {
                    pieHtml += legendItem(getColorValue(pieSerie.color, pi), pieSerie.labels[pi]);
                }
                return pieHtml + '</div>';
            }

            // Single series with multiple colors: item-level legend
            // Skip for chart types that already show labels on each item
            if (series.length === 1 && !render.stacked) {
                var serie = series[0];
                if (serie.color.length <= 1) return '';
                if (type === 'bar' || type === 'column' || type === 'waterfall' || type === 'progress') return '';
                var html = '<div class="nc-legend">';
                for (var i = 0; i < serie.labels.length; i++) {
                    html += legendItem(getColorValue(serie.color, i), serie.labels[i]);
                }
                return html + '</div>';
            }

            // Multi-series: series-level legend
            if (series.length < 2) return '';

            var html = '<div class="nc-legend">';
            series.forEach(function (serie, idx) {
                html += legendItem(getColorValue(serie.color, idx), serie.title);
            });
            return html + '</div>';
        }

        // Coerce to a number so it's safe to interpolate into inline grid-template style strings.
        var gap = num(config.gap !== undefined ? config.gap : 2, 2);
        var groupGap = Math.max(1, Math.floor(gap / 2));

        // Build classes
        var classes = ['nc-chart'];
        classes.push(type === 'line' ? 'nc-linechart' : 'nc-' + type);
        if (render.stacked) classes.push('is-stacked');
        if (config.cssClass) classes.push(sanitizeClass(config.cssClass));
        if (config.layout.height === 'auto') classes.push('has-height-auto');
        if (config.fit) classes.push('is-fit');
        if (config.highlight) classes.push('has-highlight');
        if (config.animate) classes.push('nc-animate');
        if (config.theme === 'light') classes.push('nc-light');
        if (type === 'funnel' && config.funnel.direction === 'horizontal') classes.push('is-funnel-horizontal');
        if (type === 'funnel' && config.funnel.flip) classes.push('is-funnel-flipped');
        if (waterfallVertical) classes.push('is-waterfall-vertical');

        var heightProp = type === 'gauge' ? 'height' : 'min-height';
        var safeWidth = sanitizeLength(config.layout.width, '100%');
        var safeHeight = sanitizeLength(config.layout.height, '300px');
        var ariaLabel = (config.title.text ? config.title.text + ' — ' : '') + type + ' chart';
        // The container is a labelled group (NOT role="img", which would hide the title, legend,
        // axis labels, and the screen-reader data table below from assistive tech). role="img" is
        // scoped to the purely-visual .nc-plot instead (see plotStyle below).
        var chartTemplate = '<div class="' + classes.join(' ') + '" role="group" aria-label="' + escapeHtml(ariaLabel) + '" style="width:' + safeWidth + ';' + heightProp + ':' + safeHeight + '">';
        if (config.title.text) {
            chartTemplate += '<div class="nc-title" style="text-align:' + sanitizeAlign(config.title.align) + '">' + escapeHtml(config.title.text);
            if (config.title.subtitle) {
                chartTemplate += '<div class="nc-subtitle">' + escapeHtml(config.title.subtitle) + '</div>';
            }
            chartTemplate += '</div>';
        }
        chartTemplate += '<div class="nc-chart-body">';

        var useGrid = (type === 'line' || type === 'area' || type === 'column' || type === 'bar' || type === 'waterfall' || type === 'bullet');
        // Vertical waterfall lays out column-style (value axis on y, category labels on x), so it is
        // NOT a horizontal bar. Horizontal waterfall stays grouped with bar/bullet.
        var isHorizontalBar = (type === 'bar' || type === 'bullet' || (type === 'waterfall' && !waterfallVertical));
        var skipGuidelines = type === 'gauge' || type === 'heatmap' || type === 'treemap' || type === 'progress' || type === 'pie' || type === 'funnel' || (type === 'bar' && render.stacked);

        // Bar/waterfall: render y-axis labels (category names) before the plot
        if (isHorizontalBar && series.length > 0 && series[0].labels.length > 0) {
            var isGrouped = series.length > 1 && !render.stacked;
            var yHtml = '<div class="nc-yaxis">';
            var len = series[0].values.length;
            if (isGrouped) {
                for (var yi = 0; yi < len; yi++) {
                    yHtml += '<div class="nc-label-group">';
                    yHtml += '<span class="nc-label-item"><span class="nc-label-text">' + escapeHtml(series[0].labels[yi]) + '</span></span>';
                    yHtml += '</div>';
                }
            } else {
                for (var yi = 0; yi < len; yi++) {
                    yHtml += '<span class="nc-label-item"><span class="nc-label-text">' + escapeHtml(series[0].labels[yi]) + '</span></span>';
                }
            }
            yHtml += '</div>';
            chartTemplate += yHtml;
        }

        var plotStyle = '';
        if (type === 'gauge') {
            // Coerce to numbers so a string can't break out of the style attribute.
            plotStyle = ' style="--gauge-thickness:' + num(config.gauge.thickness, 14) + 'px;--gauge-value-size:' + num(config.gauge.valueFontSize, 48) + 'px"';
        }
        // The plot is the visual-only surface: mark it role="img" with the chart's aria-label and
        // hide its inner nodes from AT (the real data is exposed by the SR table appended below).
        chartTemplate += '<div class="nc-canvas nc-plot" role="img" aria-label="' + escapeHtml(ariaLabel) + '"' + plotStyle + '>';
        if (!skipGuidelines) {
            if (render.threshold && render.threshold.length) {
                chartTemplate += renderThreshold(isHorizontalBar);
            }
            chartTemplate += renderGuidelines(config.layout.lines.number);
        }

        // Gauge renders from values alone (current/min/max) and never displays labels, so it must
        // not require a labels array; every other type needs labels for its axis/legend/items.
        var hasRenderableData = series.length > 0 && series[0].values.length > 0 &&
            (type === 'gauge' || series[0].labels.length > 0);
        if (hasRenderableData) {
            switch (type) {
                case 'column':
                    chartTemplate += render.stacked ? renderStackedColumn() : renderColumn();
                    break;
                case 'bar':
                    chartTemplate += render.stacked ? renderStackedBar() : renderBar();
                    break;
                case 'progress':
                    chartTemplate += renderHorizontalStacked(true);
                    break;
                case 'waterfall':
                    chartTemplate += renderWaterfall();
                    break;
                case 'line':
                case 'area':
                    chartTemplate += renderLineArea();
                    break;
                case 'heatmap':
                    chartTemplate += renderHeatmap();
                    break;
                case 'treemap':
                    chartTemplate += renderTreemap();
                    break;
                case 'gauge':
                    chartTemplate += renderGauge();
                    break;
                case 'pie':
                    chartTemplate += renderPie();
                    break;
                case 'bullet':
                    chartTemplate += renderBullet();
                    break;
                case 'funnel':
                    chartTemplate += renderFunnel();
                    break;
                default:
                    chartTemplate += renderBar();
                    break;
            }
        } else {
            chartTemplate += renderEmpty();
        }

        chartTemplate += '</div>'; // close .nc-plot

        // For grid layouts, render axis labels outside .nc-plot but inside .nc-chart-body
        if (useGrid && !skipGuidelines && !isHorizontalBar) {
            // Line/area/column: y-axis = guideline values on the right
            chartTemplate += renderAxisLabels(config.layout.lines.number, 'y');
        }

        // Footer: x-axis + legend — always rendered for consistent height across sibling charts
        chartTemplate += '<div class="nc-footer">';

        if (useGrid && !skipGuidelines) {
            if (isHorizontalBar) {
                // Bar/waterfall: x-axis = guideline values (horizontal axis)
                chartTemplate += renderAxisLabels(config.layout.lines.number, 'x');
            } else if (series.length > 0 && series[0].labels.length > 0) {
                // Line/area/column: x-axis = series labels
                var xHtml = '<div class="nc-xaxis">';
                var lbls = series[0].labels;
                for (var li = 0; li < lbls.length; li++) {
                    xHtml += '<span class="nc-axis-label">' + escapeHtml(lbls[li]) + '</span>';
                }
                xHtml += '</div>';
                chartTemplate += xHtml;
            }
        }

        chartTemplate += renderLegend();
        chartTemplate += '</div>'; // close .nc-footer
        chartTemplate += '</div>'; // close .nc-chart-body
        if (hasRenderableData) {
            chartTemplate += renderSrTable();
        }
        chartTemplate += '</div>';

        // Clean up previous instance
        if (element._ncDestroy) {
            element._ncDestroy();
        }

        element.innerHTML = chartTemplate;

        // Event callbacks
        var clickHandler = null;
        var keyHandler = null;
        var hoverHandler = null;
        var hoverLeaveHandler = null;

        function getEventData(target) {
            var el = target.closest('[data-nc-series]');
            if (!el) return null;
            var si = parseInt(el.dataset.ncSeries, 10);
            var ii = parseInt(el.dataset.ncIndex, 10);
            var serie = series[si];
            if (!serie) return null;
            return {
                seriesIndex: si,
                index: ii,
                value: serie.values[ii],
                label: serie.labels[ii],
                seriesTitle: serie.title,
                element: el
            };
        }

        if (config.onClick) {
            clickHandler = function (e) {
                var data = getEventData(e.target);
                if (data) config.onClick(data, e);
            };
            element.addEventListener('click', clickHandler);

            // Keyboard activation: Enter/Space on a focused data item fires onClick, matching the
            // role="button" the item advertises.
            keyHandler = function (e) {
                if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
                var data = getEventData(e.target);
                if (data) {
                    e.preventDefault();
                    config.onClick(data, e);
                }
            };
            element.addEventListener('keydown', keyHandler);
        }

        if (config.onHover) {
            // Fire once per item, not once per child element entered.
            var lastHoverKey = null;
            hoverHandler = function (e) {
                var data = getEventData(e.target);
                if (!data) return;
                var key = data.seriesIndex + ':' + data.index;
                if (key === lastHoverKey) return;
                lastHoverKey = key;
                config.onHover(data, e);
            };
            hoverLeaveHandler = function () {
                lastHoverKey = null;
            };
            element.addEventListener('mouseover', hoverHandler);
            element.addEventListener('mouseleave', hoverLeaveHandler);
        }

        // Post-render: position line segments
        var resizeHandler = null;
        var gaugeAnimId = null;

        function getSmoothedValues(si) {
            if (!_smoothCache[si]) {
                _smoothCache[si] = config.smooth ? interpolatePoints(series[si].values, SMOOTH_STEPS) : series[si].values;
            }
            return _smoothCache[si];
        }

        function positionSegments(canvas, segs) {
            var cw = canvas.clientWidth;
            var ch = canvas.clientHeight;
            var range = effectiveRange();

            segs.forEach(function (seg) {
                var si = parseInt(seg.dataset.series, 10);
                var gi = parseInt(seg.dataset.seg, 10);
                var vals = getSmoothedValues(si);
                var total = vals.length;

                var v1 = vals[gi];
                var v2 = vals[gi + 1];
                var x1 = (gi / (total - 1)) * cw;
                var y1 = (1 - (range > 0 ? (v1 - minValue) / range : 0)) * ch;
                var x2 = ((gi + 1) / (total - 1)) * cw;
                var y2 = (1 - (range > 0 ? (v2 - minValue) / range : 0)) * ch;

                var dx = x2 - x1;
                var dy = y2 - y1;
                var dist = Math.sqrt(dx * dx + dy * dy);
                var angle = Math.atan2(dy, dx) * 180 / Math.PI;

                // Compositor-friendly: a single transform write instead of left/top/width (which are
                // layout-bound and forced the transition-disable + reflow dance every resize frame).
                // The segment is a 1px unit bar (CSS) with transform-origin:0 50%, so translate places
                // its start, rotate orients it, and scaleX stretches it to length.
                seg.style.transform = 'translate(' + toFixed3(x1) + 'px,' + toFixed3(y1) + 'px) rotate(' + toFixed3(angle) + 'deg) scaleX(' + toFixed3(dist) + ')';
            });
        }

        function positionAreaFills(canvas) {
            var range = effectiveRange();
            var fills = canvas.querySelectorAll('.nc-area-fill');

            fills.forEach(function (fill) {
                var si = parseInt(fill.dataset.areaSeries, 10);
                var vals = getSmoothedValues(si);
                var total = vals.length;
                var poly = [];

                for (var i = 0; i < total; i++) {
                    var xPct = toFixed3((i / (total - 1)) * 100);
                    var yPct = toFixed3((1 - (range > 0 ? (vals[i] - minValue) / range : 0)) * 100);
                    poly.push(xPct + '% ' + yPct + '%');
                }
                // Close polygon along the zero baseline (chart bottom when all values >= 0)
                var baseYPct = toFixed3((1 - (range > 0 ? (0 - minValue) / range : 0)) * 100);
                poly.push('100% ' + baseYPct + '%');
                poly.push('0% ' + baseYPct + '%');
                fill.style.clipPath = 'polygon(' + poly.join(',') + ')';
            });
        }

        function positionDots(canvas, dots) {
            var cw = canvas.clientWidth;
            var ch = canvas.clientHeight;
            if (!cw || !ch) return;
            var range = effectiveRange();

            dots.forEach(function (dot) {
                var si = parseInt(dot.dataset.dotSeries, 10);
                var di = parseInt(dot.dataset.dotIndex, 10);
                var serie = series[si];
                var val = serie.values[di];
                var len = serie.values.length;
                if (len <= 1) return;
                var x = (di / (len - 1)) * cw;
                var y = (1 - (range > 0 ? (val - minValue) / range : 0)) * ch;
                dot.style.left = x + 'px';
                dot.style.top = y + 'px';
            });
        }

        var resizeObserver = null;
        var pendingResizeRaf = null; // hoisted so destroy() can cancel a queued resize callback

        function toggleLegend(el) {
            var legend = el.querySelector('.nc-legend');
            if (!legend) return;
            // Measure at natural size, then hide VISUALLY (nc-legend-hidden = visually-hidden) rather
            // than display:none, so on small charts the color key stays available to screen readers.
            legend.classList.remove('nc-legend-hidden');
            var legendH = legend.offsetHeight;
            var chartH = el.clientHeight;
            if (legendH > chartH / 3) legend.classList.add('nc-legend-hidden');
        }

        function observeResize(callback) {
            var debounced = function () {
                if (pendingResizeRaf) cancelAnimationFrame(pendingResizeRaf);
                pendingResizeRaf = requestAnimationFrame(function () {
                    pendingResizeRaf = null;
                    callback();
                });
            };
            if (typeof ResizeObserver !== 'undefined') {
                resizeObserver = new ResizeObserver(debounced);
                resizeObserver.observe(element);
            } else {
                resizeHandler = debounced;
                window.addEventListener('resize', resizeHandler);
            }
        }

        function sizeColumns(canvas) {
            var children = getCanvasChildren(canvas);
            var n = children.length;
            if (!n) return;

            var totalGap = gap * (n - 1);
            var available = canvas.clientWidth - totalGap;
            // Every column gets the same integer width for pixel-perfect, even shapes; any leftover
            // (available % n) is left as trailing space at the end of the plot rather than spread
            // across items (which would make some 1px wider than others).
            var baseWidth = Math.floor(available / n);
            var left = 0;

            // Get matching x-axis labels from footer
            var xaxis = element.querySelector('.nc-xaxis');
            var xLabels = xaxis ? xaxis.querySelectorAll('.nc-axis-label') : [];

            for (var i = 0; i < n; i++) {
                var w = baseWidth;
                var el = children[i];
                el.style.position = 'absolute';
                if (!el.style.bottom) el.style.bottom = '0';
                el.style.left = left + 'px';
                el.style.width = w + 'px';

                // Size items within groups
                if (el.classList.contains('nc-group') || el.classList.contains('nc-stack')) {
                    var items = el.querySelectorAll('.nc-item');
                    var gn = items.length;
                    if (gn > 0 && el.classList.contains('nc-group')) {
                        var gTotalGap = groupGap * (gn - 1);
                        var gAvail = w - gTotalGap;
                        // Uniform integer width per bar; leftover trails at the end of the group.
                        var gBase = Math.floor(gAvail / gn);
                        var gLeft = 0;
                        for (var j = 0; j < gn; j++) {
                            var gw = gBase;
                            items[j].style.position = 'absolute';
                            if (!items[j].style.bottom) items[j].style.bottom = '0';
                            items[j].style.left = gLeft + 'px';
                            items[j].style.width = gw + 'px';
                            gLeft += gw + groupGap;
                        }
                    }
                    el.style.height = '100%';
                }

                // Position matching x-axis label
                if (xLabels[i]) {
                    xLabels[i].style.position = 'absolute';
                    xLabels[i].style.left = left + 'px';
                    xLabels[i].style.width = w + 'px';
                    xLabels[i].style.textAlign = 'center';
                }

                left += w + gap;
            }

            // Set xaxis to relative positioning so absolute labels work
            if (xaxis) {
                xaxis.style.position = 'relative';
                xaxis.style.height = '18px';
            }
        }

        function sizeBars(canvas) {
            var children = getCanvasChildren(canvas);
            var n = children.length;
            if (!n) return;

            var totalGap = gap * (n - 1);
            var available = canvas.clientHeight - totalGap;
            // Every bar gets the same integer height for pixel-perfect, even shapes; any leftover
            // (available % n) is left as trailing space at the end of the plot rather than spread
            // across items (which would make some 1px taller than others).
            var baseHeight = Math.floor(available / n);
            var top = 0;

            var yaxis = element.querySelector('.nc-yaxis');
            var yLabels = [];
            if (yaxis) {
                for (var y = 0; y < yaxis.children.length; y++) {
                    yLabels.push(yaxis.children[y]);
                }
            }

            for (var i = 0; i < n; i++) {
                var h = baseHeight;
                var el = children[i];
                el.style.position = 'absolute';
                el.style.top = top + 'px';
                el.style.height = h + 'px';

                if (el.classList.contains('nc-group') || el.classList.contains('nc-stack')) {
                    el.style.left = '0';
                    el.style.width = '100%';

                    // Size items within groups
                    if (el.classList.contains('nc-group')) {
                        var items = [];
                        for (var gi = 0; gi < el.children.length; gi++) {
                            if (el.children[gi].classList.contains('nc-item')) items.push(el.children[gi]);
                        }
                        var gn = items.length;
                        if (gn > 0) {
                            var gTotalGap = groupGap * (gn - 1);
                            var gAvail = h - gTotalGap;
                            // Uniform integer height per bar; leftover trails at the end of the group.
                            var gBase = Math.floor(gAvail / gn);
                            var gTop = 0;
                            for (var j = 0; j < gn; j++) {
                                var gh = gBase;
                                items[j].style.position = 'absolute';
                                items[j].style.left = '0';
                                items[j].style.top = gTop + 'px';
                                items[j].style.height = gh + 'px';
                                gTop += gh + groupGap;
                            }
                        }
                    }
                } else if (type !== 'waterfall') {
                    el.style.left = '0';
                    // Preserve the value-proportional width from renderBar (don't stretch to full plot)
                    var barPct = el.getAttribute('data-nc-width');
                    el.style.width = (barPct != null ? barPct + '%' : '100%');
                }

                if (yLabels[i]) {
                    yLabels[i].style.flex = 'none';
                    yLabels[i].style.height = h + 'px';
                }

                top += h + gap;
            }

            if (yaxis) {
                yaxis.style.gap = gap + 'px';
            }
        }

        // Bar values sit just past the bar's right edge. When a bar is long enough that
        // the value would overflow the plot, flip it to sit inside the bar instead.
        // The bar's final width comes from its inline width:% (the grow animation transform
        // would make a measured rect unreliable mid-animation), so derive it from that.
        function positionBarValues(canvas) {
            var plotW = canvas.clientWidth;
            if (!plotW) return;
            var values = canvas.querySelectorAll('.nc-item > .nc-main > .nc-value');
            var n = values.length;
            var bars = [];
            // Phase 1: reset every value to outside (write-only, no interleaved reads).
            for (var i = 0; i < n; i++) {
                var bar = values[i].closest('.nc-item');
                bars[i] = bar;
                if (bar) bar.classList.remove('nc-value-inside');
            }
            // Phase 2: read all scrollWidths in one batch (single layout flush, not one per bar).
            var needed = [];
            for (var j = 0; j < n; j++) {
                needed[j] = values[j].scrollWidth + 8; // label width + padding
            }
            // Phase 3: apply the class where the value would overflow the plot.
            for (var k = 0; k < n; k++) {
                if (!bars[k]) continue;
                var pct = parseFloat(bars[k].getAttribute('data-nc-width')); // final width as % of plot
                if (isNaN(pct)) continue;
                if ((pct / 100) * plotW + needed[k] > plotW) {
                    bars[k].classList.add('nc-value-inside');
                }
            }
        }

        function sizeTreemap(plot) {
            var cells = plot.querySelectorAll('.nc-treemap-cell');
            if (!cells.length) return;

            var pw = plot.clientWidth;
            var ph = plot.clientHeight;
            var halfGap = gap / 2;

            for (var i = 0; i < cells.length; i++) {
                var cell = cells[i];
                // Store original percentages on first call
                if (!cell.dataset.xPct) {
                    cell.dataset.xPct = parseFloat(cell.style.left);
                    cell.dataset.yPct = parseFloat(cell.style.top);
                    cell.dataset.wPct = parseFloat(cell.style.width);
                    cell.dataset.hPct = parseFloat(cell.style.height);
                }

                var xPct = parseFloat(cell.dataset.xPct) / 100;
                var yPct = parseFloat(cell.dataset.yPct) / 100;
                var wPct = parseFloat(cell.dataset.wPct) / 100;
                var hPct = parseFloat(cell.dataset.hPct) / 100;

                var x = Math.round(xPct * pw + halfGap);
                var y = Math.round(yPct * ph + halfGap);
                var x2 = Math.round((xPct + wPct) * pw - halfGap);
                var y2 = Math.round((yPct + hPct) * ph - halfGap);

                cell.style.left = x + 'px';
                cell.style.top = y + 'px';
                cell.style.width = Math.max(0, x2 - x) + 'px';
                cell.style.height = Math.max(0, y2 - y) + 'px';
            }
        }

        // Give each funnel band an equal integer extent along the flow axis (height when vertical,
        // width when horizontal) so the trapezoids are pixel-perfect. The leftover (extent % n) is
        // left as trailing space at the end of the plot, matching column/bar.
        function sizeFunnel(plot) {
            var wraps = plot.querySelectorAll('.nc-funnel-wrap');
            var n = wraps.length;
            if (!n) return;
            var horizontal = config.funnel.direction === 'horizontal';
            var extent = horizontal ? plot.clientWidth : plot.clientHeight;
            var base = Math.floor(extent / n);
            for (var i = 0; i < n; i++) {
                var wrap = wraps[i];
                wrap.style.flex = 'none';
                if (horizontal) {
                    wrap.style.width = base + 'px';
                    wrap.style.height = '';
                } else {
                    wrap.style.height = base + 'px';
                    wrap.style.width = '';
                }
            }
        }

        if (type === 'funnel') {
            var funnelPlot = element.querySelector('.nc-plot');
            sizeFunnel(funnelPlot);
            observeResize(function () { sizeFunnel(funnelPlot); });
        }

        if (type === 'column') {
            var colCanvas = element.querySelector('.nc-plot');
            // Cache the item NodeList once (the DOM is stable between render and destroy) instead of
            // re-querying every resize frame.
            var colItems = colCanvas.querySelectorAll('.nc-item');
            sizeColumns(colCanvas);

            observeResize(function () {
                colItems.forEach(function (el) { el.style.transition = 'none'; });
                sizeColumns(colCanvas);
                toggleLegend(element);
                colCanvas.offsetHeight;
                colItems.forEach(function (el) { el.style.transition = ''; });
            });
        }

        if (type === 'bar' || type === 'waterfall') {
            var barCanvas = element.querySelector('.nc-plot');
            sizeBars(barCanvas);
            positionBarValues(barCanvas);

            observeResize(function () {
                sizeBars(barCanvas);
                positionBarValues(barCanvas);
                toggleLegend(element);
            });

            // Sync highlight between plot items and y-axis labels
            if (config.highlight) {
                var hlYaxis = element.querySelector('.nc-yaxis');
                if (hlYaxis) {
                    var hlChildren = [];
                    for (var hi = 0; hi < barCanvas.children.length; hi++) {
                        var hc = barCanvas.children[hi];
                        if (!hc.classList.contains('nc-guidelines') && !hc.classList.contains('nc-threshold')) {
                            hlChildren.push(hc);
                        }
                    }

                    var hlLabels = [];
                    for (var hi = 0; hi < hlYaxis.children.length; hi++) {
                        hlLabels.push(hlYaxis.children[hi]);
                    }

                    function hlFindIndex(target, container, children) {
                        var el = target.closest('.nc-item, .nc-group, .nc-stack');
                        if (!el) return -1;
                        if (el.classList.contains('nc-item') && el.parentElement !== container) {
                            el = el.parentElement;
                        }
                        return children.indexOf(el);
                    }

                    function hlDimLabels(idx) {
                        for (var i = 0; i < hlLabels.length; i++) {
                            hlLabels[i].style.opacity = i === idx ? '1' : '.3';
                            hlLabels[i].style.transition = 'opacity .25s';
                        }
                    }

                    function hlDimItems(idx) {
                        for (var i = 0; i < hlChildren.length; i++) {
                            hlChildren[i].style.opacity = i === idx ? '1' : '.3';
                            hlChildren[i].style.transition = 'opacity .25s';
                        }
                    }

                    function hlClear() {
                        for (var i = 0; i < hlLabels.length; i++) {
                            hlLabels[i].style.opacity = '';
                            hlLabels[i].style.transition = '';
                        }
                        for (var i = 0; i < hlChildren.length; i++) {
                            hlChildren[i].style.opacity = '';
                            hlChildren[i].style.transition = '';
                        }
                    }

                    // Hovering items → dim labels
                    barCanvas.addEventListener('mouseover', function (e) {
                        var idx = hlFindIndex(e.target, barCanvas, hlChildren);
                        if (idx >= 0) hlDimLabels(idx);
                    });
                    barCanvas.addEventListener('mouseleave', hlClear);

                    // Hovering labels → dim items and labels
                    hlYaxis.addEventListener('mouseover', function (e) {
                        var label = e.target.closest('.nc-label-item, .nc-label-group');
                        if (!label) return;
                        // Find index: label-group wraps label-item, so check the direct child
                        var directChild = label.classList.contains('nc-label-group') ? label : label.parentElement;
                        var idx;
                        if (directChild.classList.contains('nc-label-group')) {
                            idx = hlLabels.indexOf(directChild);
                        } else {
                            idx = hlLabels.indexOf(label);
                        }
                        if (idx >= 0) {
                            hlDimLabels(idx);
                            hlDimItems(idx);
                        }
                    });
                    hlYaxis.addEventListener('mouseleave', hlClear);
                }
            }
        }

        if (type === 'treemap') {
            var treemapPlot = element.querySelector('.nc-plot');
            sizeTreemap(treemapPlot);

            observeResize(function () {
                sizeTreemap(treemapPlot);
                toggleLegend(element);
            });
        }

        if (type === 'line' || type === 'area') {
            var canvas = element.querySelector('.nc-plot');
            var segs = canvas.querySelectorAll('.nc-line-segment');
            var dots = canvas.querySelectorAll('.nc-dot');

            positionSegments(canvas, segs);
            positionDots(canvas, dots);
            positionAreaFills(canvas);

            // Segments now animate via `transform` only (compositor-friendly), so the old
            // transition-disable + forced-reflow dance is unnecessary. Dots still use left/top; keep
            // their transitions suppressed during resize so they snap instead of lagging.
            observeResize(function () {
                dots.forEach(function (d) { d.style.transition = 'none'; });
                positionSegments(canvas, segs);
                positionDots(canvas, dots);
                positionAreaFills(canvas);
                toggleLegend(element);
                canvas.offsetHeight;
                dots.forEach(function (d) { d.style.transition = ''; });
            });
        }

        if (type === 'gauge') {
            var ring = element.querySelector('.nc-ring');
            if (ring) {
                var gStart = parseFloat(ring.dataset.start);
                var gArc = parseFloat(ring.dataset.arc);
                var gPct = parseFloat(ring.dataset.pct);
                var gColor = ring.dataset.color;
                var gTrack = ring.dataset.track;
                var gNum = parseFloat(ring.dataset.valueNum);
                var gPre = ring.dataset.valuePrefix;
                var gSuf = ring.dataset.valueSuffix;
                var gDec = parseInt(ring.dataset.valueDecimals, 10);
                var gValEl = element.querySelector('.nc-ring-content .nc-value');
                var gDuration = GAUGE_ANIM_DURATION;
                var gStartTime = null;

                function easeOut(t) {
                    return 1 - Math.pow(1 - t, 3);
                }

                function paintGauge(eased) {
                    var fill = (eased * gPct * gArc).toFixed(1);

                    ring.style.background = 'conic-gradient(from ' + gStart + 'deg, '
                        + gColor + ' 0deg, ' + gColor + ' ' + fill + 'deg, '
                        + gTrack + ' ' + fill + 'deg, ' + gTrack + ' ' + gArc + 'deg, '
                        + 'transparent ' + gArc + 'deg)';

                    gValEl.textContent = gPre + (eased * gNum).toFixed(gDec) + gSuf;
                }

                function animateGauge(timestamp) {
                    if (!gStartTime) gStartTime = timestamp;
                    var progress = Math.min((timestamp - gStartTime) / gDuration, 1);
                    paintGauge(easeOut(progress));

                    if (progress < 1) {
                        gaugeAnimId = requestAnimationFrame(animateGauge);
                    }
                }

                var reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
                if (!config.animate || reduceMotion) {
                    paintGauge(1);
                } else {
                    gaugeAnimId = requestAnimationFrame(animateGauge);
                }
            }
        }

        var pieRing = (type === 'pie') ? element.querySelector('.nc-pie-ring') : null;
        if (pieRing) {
            var pieHighlight = element.querySelector('.nc-pie-highlight');
            var pieTips = element.querySelectorAll('.nc-pie-tip-item');
            var pieTotal = parseFloat(pieRing.dataset.ncPieTotal);

            // Compute slice boundaries (degrees from 12 o'clock, clockwise). These stay gapless so
            // hover hit-testing covers the full ring with no dead zones in the visual gaps.
            var sliceBounds = [];
            var pieAngle = 0;
            var pieSerie = series[0];
            for (var pi = 0; pi < pieSerie.values.length; pi++) {
                var sliceDeg = (pieVal(pieSerie.values[pi]) / pieTotal) * 360;
                sliceBounds.push({ start: pieAngle, end: pieAngle + sliceDeg });
                pieAngle += sliceDeg;
            }

            // The slice gap is specified in px; convert it to degrees from the rendered outer
            // radius (gap arc length / circumference). The smallest slice never changes after
            // render, so cap once here; the radius only changes on resize, so the resulting
            // gapDeg is cached in `pieGapDeg` and recomputed only when we repaint.
            // Slice gaps only apply to donuts (innerRadius > 0). On a full pie the transparent
            // wedges would expose the chart background as thin spokes meeting at the centre, which
            // reads as noise; the hole of a donut gives the gaps a clean inner edge.
            var pieHasGap = gap > 0 && pieSerie.values.length > 1 && config.pie.innerRadius > 0;
            var pieMinSliceDeg = 360;
            for (var pmi = 0; pmi < sliceBounds.length; pmi++) {
                var pmd = sliceBounds[pmi].end - sliceBounds[pmi].start;
                if (pmd < pieMinSliceDeg) pieMinSliceDeg = pmd;
            }
            var pieGapDeg = 0;
            function computeGapDeg() {
                if (!pieHasGap) return 0;
                var r = pieRing.getBoundingClientRect().width / 2;
                if (r <= 0) return 0;
                var deg = (gap / (2 * Math.PI * r)) * 360;
                // Never let gaps eat a whole slice: cap at half the smallest slice.
                return Math.min(deg, pieMinSliceDeg / 2);
            }
            function paintPieRing() {
                pieGapDeg = computeGapDeg();
                // The donut mask lives in a separate style property, so overwriting `background`
                // here leaves it intact.
                pieRing.style.background = pieSheen + 'conic-gradient(from 0deg,' + pieSliceStops(pieSerie, pieTotal, pieGapDeg) + ')';
            }
            if (pieHasGap) {
                // Paint once now, and again next frame: at init the ring may not be laid out yet
                // (radius 0 ⇒ no gap), so the deferred pass applies the gap once a size is known.
                paintPieRing();
                if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(paintPieRing);
                // The pie claims the single shared resize observer, so it must also drive the
                // legend auto-hide that the fallback at the end of render() would otherwise own.
                observeResize(function () { paintPieRing(); toggleLegend(element); });
            }

            function getPieSliceIndex(e) {
                var rect = pieRing.getBoundingClientRect();
                var cx = rect.left + rect.width / 2;
                var cy = rect.top + rect.height / 2;
                var dx = e.clientX - cx;
                var dy = e.clientY - cy;

                var dist = Math.sqrt(dx * dx + dy * dy);
                var radius = rect.width / 2;
                if (dist > radius) return -1;

                var innerR = config.pie.innerRadius;
                if (innerR > 0 && dist < radius * innerR / 100) return -1;

                // Angle from top, clockwise (matching conic-gradient from 0deg)
                var angleDeg = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;

                for (var si = 0; si < sliceBounds.length; si++) {
                    if (angleDeg >= sliceBounds[si].start && angleDeg < sliceBounds[si].end) {
                        return si;
                    }
                }
                return -1;
            }

            var activePieTip = -1;

            // Show the tooltip + highlight overlay for slice `idx` (-1 clears). Shared by mouse
            // hover and keyboard navigation so both paths behave identically.
            function showPieSlice(idx) {
                activePieTip = idx;
                for (var t = 0; t < pieTips.length; t++) {
                    pieTips[t].style.display = t === idx ? '' : 'none';
                }
                if (idx >= 0 && pieHighlight) {
                    var s = sliceBounds[idx];
                    var h = pieGapDeg > 0 ? insetSlice(s.start, s.end, pieGapDeg / 2) : s;
                    var hlColor = 'var(--nc-highlight-overlay, rgba(255,255,255,0.15))';
                    pieHighlight.style.background = 'conic-gradient(from 0deg, transparent ' + toFixed3(h.start) + 'deg, ' + hlColor + ' ' + toFixed3(h.start) + 'deg ' + toFixed3(h.end) + 'deg, transparent ' + toFixed3(h.end) + 'deg)';
                    pieHighlight.style.display = '';
                } else if (pieHighlight) {
                    pieHighlight.style.display = 'none';
                }
            }

            pieRing.addEventListener('mousemove', function (e) {
                var idx = getPieSliceIndex(e);
                if (idx === activePieTip) return;
                // Fire onHover only when the hovered slice changes, not on every mousemove
                if (idx >= 0 && config.onHover) config.onHover(pieEventData(idx), e);
                showPieSlice(idx);
            });

            pieRing.addEventListener('mouseleave', function () {
                showPieSlice(-1);
            });

            function pieEventData(idx) {
                return { seriesIndex: 0, index: idx, value: pieSerie.values[idx], label: pieSerie.labels[idx], seriesTitle: pieSerie.title, element: pieRing };
            }

            // Keyboard: the ring is focusable (tabindex set below); arrows cycle slices and
            // Enter/Space fires onClick — the pie's counterpart to the item keydown handler.
            if (sliceBounds.length) {
                pieRing.setAttribute('tabindex', '0');
                pieRing.setAttribute('role', config.onClick ? 'button' : 'img');
                pieRing.setAttribute('aria-label', ariaLabel);
                pieRing.addEventListener('focus', function () {
                    if (activePieTip < 0) showPieSlice(0);
                });
                pieRing.addEventListener('blur', function () { showPieSlice(-1); });
                pieRing.addEventListener('keydown', function (e) {
                    var n = sliceBounds.length;
                    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        showPieSlice(((activePieTip < 0 ? -1 : activePieTip) + 1 + n) % n);
                    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        showPieSlice(((activePieTip < 0 ? 0 : activePieTip) - 1 + n) % n);
                    } else if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') && config.onClick && activePieTip >= 0) {
                        e.preventDefault();
                        config.onClick(pieEventData(activePieTip), e);
                    }
                });
            }

            if (config.onClick) {
                pieRing.addEventListener('click', function (e) {
                    var idx = getPieSliceIndex(e);
                    if (idx >= 0) config.onClick(pieEventData(idx), e);
                });
            }
        }

        if (type === 'bullet') {
            var bulletCanvas = element.querySelector('.nc-plot');
            sizeBars(bulletCanvas);

            observeResize(function () {
                sizeBars(bulletCanvas);
                toggleLegend(element);
            });
        }

        // Toggle legend on initial render and set up observer for chart types without one
        toggleLegend(element);
        if (!resizeObserver && !resizeHandler) {
            observeResize(function () { toggleLegend(element); });
        }

        function destroy() {
            if (clickHandler) element.removeEventListener('click', clickHandler);
            if (keyHandler) element.removeEventListener('keydown', keyHandler);
            if (hoverHandler) element.removeEventListener('mouseover', hoverHandler);
            if (hoverLeaveHandler) element.removeEventListener('mouseleave', hoverLeaveHandler);
            if (resizeHandler) window.removeEventListener('resize', resizeHandler);
            if (resizeObserver) resizeObserver.disconnect();
            if (gaugeAnimId) cancelAnimationFrame(gaugeAnimId);
            if (pendingResizeRaf) cancelAnimationFrame(pendingResizeRaf);
            element.innerHTML = '';
            delete element._ncDestroy;
        }

        element._ncDestroy = destroy;

        // Stable handle: destroy()/update() delegate through element._ncDestroy so an old handle
        // kept after update() still targets the CURRENT instance (the previous code returned a NEW
        // object each update, so a stale handle's destroy() wiped the new chart and leaked its
        // listeners/observer). update() also carries the merged options forward and forces
        // animate:false unless the caller re-enables it, so a data refresh doesn't replay the
        // staggered entry animation every tick.
        var handle = {
            element: element,
            destroy: function () {
                if (element._ncDestroy) element._ncDestroy();
            },
            update: function (newOptions) {
                newOptions = newOptions || {};
                var mergedNew = deepMerge({ animate: false }, newOptions);
                var next = deepMerge(options || {}, mergedNew);
                // deepMerge replaces arrays wholesale, so a partial series payload (e.g. {values}
                // only) would drop labels/colors. Merge each incoming series onto the previous one
                // by index so partial updates keep the fields they didn't set.
                if (newOptions.data && newOptions.data.series && options && options.data && options.data.series) {
                    next.data.series = newOptions.data.series.map(function (s, i) {
                        var prev = options.data.series[i];
                        return prev ? deepMerge(prev, s) : s;
                    });
                }
                options = next;
                if (element._ncDestroy) element._ncDestroy();
                neoCharts(element, options);
                return handle;
            }
        };
        return handle;
    }

    return neoCharts;
});
