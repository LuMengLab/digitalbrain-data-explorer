// UI Controller - Handles DOM updates and delegates aggregation to data-model.js

const dataModel = window.DigitalNeuronModel;
const DISPLAY_NAME_ALIASES = {
    'DigitaiBrain-Data': 'DigitalBrain Data',
};
const OVERVIEW_BADGE_LIMIT = 3;
const OVERVIEW_REGION_LIMIT = 3;
const createOverviewExpansionState = () => ({
    collection: { statuses: false, brodmann: false, gyral: false },
    dataset: { statuses: false, brodmann: false, gyral: false },
});
let currentSelection = {
    collectionId: '',
    datasetId: '',
    donorId: '',
};
let overviewExpansionState = createOverviewExpansionState();
let currentCellMetric = 'composition';
let currentRegionMetric = 'composition';
let currentCellRange = 'top';
let currentRegionRange = 'top';

function getSelectionScopeKey(selection) {
    if (selection.collectionId && selection.datasetId && selection.donorId) {
        return 'donor';
    }
    if (selection.collectionId && selection.datasetId) {
        return 'dataset';
    }
    if (selection.collectionId) {
        return 'collection';
    }
    return 'global';
}

function resetScopeVisualizationState() {
    currentCellMetric = 'composition';
    currentRegionMetric = 'composition';
    currentCellRange = 'top';
    currentRegionRange = 'top';
}

function getSelection() {
    return { ...currentSelection };
}

function setSelection(collectionId, datasetId, donorId) {
    const nextSelection = {
        collectionId: collectionId || '',
        datasetId: datasetId || '',
        donorId: donorId || '',
    };
    const selectionChanged = (
        currentSelection.collectionId !== nextSelection.collectionId ||
        currentSelection.datasetId !== nextSelection.datasetId ||
        currentSelection.donorId !== nextSelection.donorId
    );
    const previousScopeKey = getSelectionScopeKey(currentSelection);
    const nextScopeKey = getSelectionScopeKey(nextSelection);

    if (selectionChanged) {
        overviewExpansionState = createOverviewExpansionState();
        if (previousScopeKey !== nextScopeKey) {
            resetScopeVisualizationState();
        }
    }

    currentSelection = nextSelection;
}

function isOverviewExpanded(overviewKey, sectionKey) {
    return Boolean(overviewExpansionState[overviewKey]?.[sectionKey]);
}

function buildOverviewToggle(overviewKey, sectionKey, hiddenCount) {
    const expanded = isOverviewExpanded(overviewKey, sectionKey);
    const label = expanded ? 'Hide details' : `Show ${hiddenCount} more`;
    return `
        <button
            type="button"
            class="overview-toggle"
            data-overview="${overviewKey}"
            data-section="${sectionKey}"
            aria-expanded="${expanded ? 'true' : 'false'}"
        >${label}</button>
    `;
}

function toggleOverviewExpansion(overviewKey, sectionKey) {
    if (!overviewExpansionState[overviewKey]) {
        overviewExpansionState[overviewKey] = {};
    }
    overviewExpansionState[overviewKey][sectionKey] = !overviewExpansionState[overviewKey][sectionKey];
    const { collectionId, datasetId, donorId } = getSelection();
    updateView(collectionId, datasetId, donorId);
}

function getScopeState(collectionId, datasetId, donorId) {
    return dataModel.computeScopeState(currentData, collectionId, datasetId, donorId);
}

function formatStatusClass(status) {
    return `status-${String(status).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function formatDisplayName(name) {
    return DISPLAY_NAME_ALIASES[name] || name;
}

function getScopeLabel(scope) {
    return formatDisplayName(scope.scopeLabel);
}

function buildBadges(statuses, limit = null) {
    if (!statuses.length) {
        return '<span class="status-badge status-muted">No disease labels</span>';
    }

    const visibleStatuses = limit ? statuses.slice(0, limit) : statuses;
    const badges = visibleStatuses
        .map((status) => `<span class="status-badge ${formatStatusClass(status)}">${status}</span>`);

    if (limit && statuses.length > limit) {
        badges.push(`<span class="status-badge status-overflow">+${statuses.length - limit} more</span>`);
    }

    return badges.join('');
}

function buildOverviewBadges(statuses, overviewKey, limit = OVERVIEW_BADGE_LIMIT) {
    if (!statuses.length) {
        return '<span class="status-badge status-muted">No disease labels</span>';
    }

    const expanded = isOverviewExpanded(overviewKey, 'statuses');
    const visibleStatuses = statuses.slice(0, limit);
    const hiddenCount = statuses.length - visibleStatuses.length;
    const summaryBadges = visibleStatuses
        .map((status) => `<span class="status-badge ${formatStatusClass(status)}">${status}</span>`)
        .join('');
    const toggle = hiddenCount > 0 ? buildOverviewToggle(overviewKey, 'statuses', hiddenCount) : '';
    const expandedPanel = expanded
        ? `<div class="overview-expanded status-badges">${buildBadges(statuses)}</div>`
        : '';

    return `
        <div class="overview-summary-inline">
            ${summaryBadges}
            ${toggle}
        </div>
        ${expandedPanel}
    `;
}

function formatShare(count, total) {
    if (!total) {
        return '0.0%';
    }
    return `${((count / total) * 100).toFixed(1)}%`;
}

function getTopEntry(counts) {
    const entries = Object.entries(counts || {})
        .filter(([, count]) => count > 0)
        .sort((left, right) => right[1] - left[1]);
    if (!entries.length) {
        return null;
    }

    const [label, count] = entries[0];
    return { label, count };
}

function buildModuleHeader(title, meta) {
    return `
        <div class="module-header">
            <span class="module-kicker">${title}</span>
            <p class="module-meta">${meta}</p>
        </div>
    `;
}

function buildHighlightGrid(items) {
    return `
        <div class="module-highlight-grid">
            ${items.map(({ label, value, meta = '' }) => `
                <div class="module-highlight-card">
                    <span class="module-highlight-label">${label}</span>
                    <strong class="module-highlight-value">${value}</strong>
                    ${meta ? `<span class="module-highlight-meta">${meta}</span>` : ''}
                </div>
            `).join('')}
        </div>
    `;
}

function buildOverviewDiseaseModule(statuses, overviewKey, donorCount) {
    const meta = statuses.length === 1
        ? `1 disease label across ${donorCount.toLocaleString()} donor${donorCount === 1 ? '' : 's'}`
        : `${statuses.length.toLocaleString()} disease labels across ${donorCount.toLocaleString()} donors`;
    return [
        buildModuleHeader('Disease Snapshot', meta),
        buildOverviewBadges(statuses, overviewKey),
    ].join('');
}

function buildRegionSummaryLine(overviewKey, sectionKey, title, items, limit) {
    const visibleItems = items.slice(0, limit);
    const hiddenCount = items.length - visibleItems.length;
    const expanded = isOverviewExpanded(overviewKey, sectionKey);
    const summary = items.length ? visibleItems.join(', ') : 'None';
    const toggle = hiddenCount > 0 ? buildOverviewToggle(overviewKey, sectionKey, hiddenCount) : '';
    const expandedPanel = expanded
        ? `
            <div class="overview-expanded">
                <div class="summary-detail-list">${items.join(', ')}</div>
            </div>
        `
        : '';

    return [
        '<div class="summary-line">',
        `<strong>${title}</strong>`,
        `<div class="overview-summary-inline">`,
        `<span>${summary}</span>`,
        `${toggle}`,
        `</div>`,
        `${expandedPanel}`,
        '</div>',
    ].join('');
}

function buildRegionsSummary(scope, overviewKey, limit = OVERVIEW_REGION_LIMIT) {
    const totalCells = scope.metrics.cells;
    const topBrodmann = getTopEntry(scope.brodCounts);
    const topGyral = getTopEntry(scope.gyralCounts);
    const highlights = buildHighlightGrid([
        {
            label: 'Top Brodmann',
            value: topBrodmann?.label || 'N/A',
            meta: topBrodmann ? `${topBrodmann.count.toLocaleString()} cells · ${formatShare(topBrodmann.count, totalCells)}` : 'No data',
        },
        {
            label: 'Top Gyral',
            value: topGyral?.label || 'N/A',
            meta: topGyral ? `${topGyral.count.toLocaleString()} cells · ${formatShare(topGyral.count, totalCells)}` : 'No data',
        },
        {
            label: 'Region Diversity',
            value: `${scope.metrics.brodmannRegions + scope.metrics.gyralRegions}`,
            meta: `${scope.metrics.brodmannRegions} Brodmann · ${scope.metrics.gyralRegions} Gyral`,
        },
    ]);

    return [
        buildModuleHeader('Region Snapshot', 'Primary regional signals and expandable full lists.'),
        highlights,
        buildRegionSummaryLine(overviewKey, 'brodmann', 'Brodmann Areas', scope.brodmannRegions, limit),
        buildRegionSummaryLine(overviewKey, 'gyral', 'Gyral Regions', scope.gyralRegions, limit),
    ].join('');
}

function buildDonorClinicalModule(donor) {
    const primaryStatus = donor.status?.[0] || 'No disease labels';
    return [
        buildModuleHeader('Clinical Snapshot', 'Primary donor disease label and normalized metadata context.'),
        `<div class="overview-summary-inline"><span class="status-badge ${formatStatusClass(primaryStatus)}">${primaryStatus}</span></div>`,
    ].join('');
}

function buildDonorHighlights(scope) {
    const totalCells = scope.metrics.cells;
    const topCellType = getTopEntry(scope.cellTypeCounts);
    const topBrodmann = getTopEntry(scope.brodCounts);
    const topGyral = getTopEntry(scope.gyralCounts);
    const highlights = buildHighlightGrid([
        {
            label: 'Top Cell Type',
            value: topCellType?.label || 'N/A',
            meta: topCellType ? `${topCellType.count.toLocaleString()} cells · ${formatShare(topCellType.count, totalCells)}` : 'No data',
        },
        {
            label: 'Top Brodmann',
            value: topBrodmann?.label || 'N/A',
            meta: topBrodmann ? `${topBrodmann.count.toLocaleString()} cells · ${formatShare(topBrodmann.count, totalCells)}` : 'No data',
        },
        {
            label: 'Top Gyral Region',
            value: topGyral?.label || 'N/A',
            meta: topGyral ? `${topGyral.count.toLocaleString()} cells · ${formatShare(topGyral.count, totalCells)}` : 'No data',
        },
        {
            label: 'Cell Type Diversity',
            value: `${Object.keys(scope.cellTypeCounts).length}`,
            meta: `${scope.metrics.brodmannRegions + scope.metrics.gyralRegions} total region labels`,
        },
    ]);

    return [
        buildModuleHeader('Composition Highlights', 'High-signal composition cues for quick donor comparison.'),
        highlights,
    ].join('');
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = value;
    }
}

function populateCollections() {
    const collectionSelect = document.getElementById('collectionSelect');
    collectionSelect.innerHTML = '<option value="">Select Collection</option>';

    dataModel.getCollections(currentData).forEach(({ id, name }) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = `${id}: ${formatDisplayName(name)}`;
        collectionSelect.appendChild(option);
    });
}

function populateDatasets(collectionId) {
    const datasetSelect = document.getElementById('datasetSelect');
    const donorSelect = document.getElementById('donorSelect');

    datasetSelect.innerHTML = '<option value="">Select Dataset</option>';
    donorSelect.innerHTML = '<option value="">Select Donor</option>';

    if (!collectionId) {
        datasetSelect.disabled = true;
        donorSelect.disabled = true;
        updateView('', '', '');
        return;
    }

    dataModel.getDatasets(currentData, collectionId).forEach(({ id, name }) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = formatDisplayName(name);
        datasetSelect.appendChild(option);
    });

    datasetSelect.disabled = false;
    donorSelect.disabled = true;
    updateView(collectionId, '', '');
}

function populateDonors(collectionId, datasetId) {
    const donorSelect = document.getElementById('donorSelect');
    donorSelect.innerHTML = '<option value="">Select Donor</option>';

    if (!collectionId || !datasetId) {
        donorSelect.disabled = true;
        updateView(collectionId, '', '');
        return;
    }

    dataModel.getDonorOptions(currentData, collectionId, datasetId).forEach(({ id, label }) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = label;
        donorSelect.appendChild(option);
    });

    donorSelect.disabled = false;
    updateView(collectionId, datasetId, '');
}

function hideAllSections() {
    document.getElementById('collectionOverview').classList.add('hidden');
    document.getElementById('datasetOverview').classList.add('hidden');
    document.getElementById('donorDetails').classList.add('hidden');
    document.getElementById('cellTypeSection').classList.add('hidden');
    document.getElementById('brainRegionsSection').classList.add('hidden');
}

function renderScopeBanner(scope) {
    const scopeLabel = getScopeLabel(scope);
    const scopeTitleMap = {
        global: 'All Collections',
        collection: scopeLabel,
        dataset: scopeLabel,
        donor: scope.scopeLabel,
    };
    const subtitleMap = {
        global: 'Global overview across every collection in the explorer.',
        collection: 'Collection-wide summary across all datasets and donors.',
        dataset: 'Dataset-level view with aggregated donor statistics and region composition.',
        donor: 'Single donor view with normalized metadata, cell types, and brain-region counts.',
    };

    setText('scopeEyebrow', `Current Scope · ${scope.scopeKey.toUpperCase()}`);
    setText('scopeTitle', scopeTitleMap[scope.scopeKey]);
    setText('scopeSubtitle', subtitleMap[scope.scopeKey]);
    // The title is truncated to one line on wide screens; expose the full text on hover.
    const scopeTitleEl = document.getElementById('scopeTitle');
    if (scopeTitleEl) {
        scopeTitleEl.title = scopeTitleMap[scope.scopeKey];
    }
    setText('scopeDatasets', scope.metrics.datasets.toLocaleString());
    setText('scopeDonors', scope.metrics.donors.toLocaleString());
    setText('scopeCells', scope.metrics.cells.toLocaleString());
}

function renderCollectionOverview(scope, title) {
    const scopeLabel = getScopeLabel(scope);
    setText('collectionOverviewTitle', title.replace(scope.scopeLabel, scopeLabel));
    setText('collectionDatasets', scope.metrics.datasets.toLocaleString());
    setText('collectionDonors', scope.metrics.donors.toLocaleString());
    setText('collectionCells', scope.metrics.cells.toLocaleString());
    setText('collectionRegionsBrod', scope.metrics.brodmannRegions.toLocaleString());
    setText('collectionRegionsGyral', scope.metrics.gyralRegions.toLocaleString());
    setText('collectionCellTypes', Object.keys(scope.cellTypeCounts).length.toLocaleString());
    document.getElementById('collectionStatuses').innerHTML = buildOverviewDiseaseModule(
        scope.statuses,
        'collection',
        scope.metrics.donors
    );
    document.getElementById('collectionRegionsSummary').innerHTML = buildRegionsSummary(scope, 'collection');
    document.getElementById('collectionOverview').classList.remove('hidden');
}

function renderDatasetOverview(scope) {
    setText('datasetOverviewTitle', `Dataset Overview · ${getScopeLabel(scope)}`);
    setText('datasetDonors', scope.metrics.donors.toLocaleString());
    setText('datasetCells', scope.metrics.cells.toLocaleString());
    setText('datasetRegionsBrod', scope.metrics.brodmannRegions.toLocaleString());
    setText('datasetRegionsGyral', scope.metrics.gyralRegions.toLocaleString());
    setText('datasetCellTypes', Object.keys(scope.cellTypeCounts).length.toLocaleString());
    document.getElementById('datasetStatuses').innerHTML = buildOverviewDiseaseModule(
        scope.statuses,
        'dataset',
        scope.metrics.donors
    );
    document.getElementById('datasetRegionsSummary').innerHTML = buildRegionsSummary(scope, 'dataset');
    document.getElementById('datasetOverview').classList.remove('hidden');
}

function renderDonorDetails(scope) {
    const donor = scope.donors[0];
    if (!donor) {
        document.getElementById('donorDetails').classList.add('hidden');
        return;
    }

    setText('donorDetailsTitle', `Donor Details · ${donor.name}`);
    setText('donorName', donor.name);
    setText('donorAge', `Age: ${donor.age?.[0] || 'N/A'}`);
    setText('donorGender', `Gender: ${donor.gender?.[0] || 'N/A'}`);
    setText('donorCellsDisplay', `${Number(donor.cells || 0).toLocaleString()} cells`);
    document.getElementById('donorStatusBadges').innerHTML = buildDonorClinicalModule(donor);
    document.getElementById('donorHighlights').innerHTML = buildDonorHighlights(scope);
    document.getElementById('donorDetails').classList.remove('hidden');
}

function sumCounts(counts) {
    return Object.values(counts || {}).reduce((sum, count) => sum + Number(count || 0), 0);
}

function sortCountEntries(counts) {
    return Object.entries(counts || {})
        .filter(([, count]) => count > 0)
        .sort((left, right) => right[1] - left[1]);
}

function buildInsightCards(items) {
    return items.map(({ label, value, meta = '' }) => `
        <div class="chart-insight-card">
            <span class="chart-insight-label">${label}</span>
            <strong class="chart-insight-value">${value}</strong>
            ${meta ? `<span class="chart-insight-meta">${meta}</span>` : ''}
        </div>
    `).join('');
}

function aggregateDatasetCounts(dataset, countKey) {
    const totals = {};
    Object.values(dataset?.donors || {}).forEach((donor) => {
        dataModel.aggregateCounts(totals, donor[countKey]);
    });
    return totals;
}

function buildTopSeries(counts, totalCells, limit = 10, includeOther = false) {
    const entries = sortCountEntries(counts);
    const visibleEntries = Number.isFinite(limit) ? entries.slice(0, limit) : entries.slice();
    if (includeOther && entries.length > limit) {
        const otherCount = entries.slice(limit).reduce((sum, [, count]) => sum + count, 0);
        visibleEntries.push(['Other', otherCount]);
    }

    return visibleEntries.map(([label, count]) => ({
        label,
        count,
        percentage: Number(formatShare(count, totalCells).replace('%', '')),
    }));
}

function getRangeOptions(range) {
    if (range === 'other') {
        return { limit: 10, includeOther: true, label: 'Top 10 + Other' };
    }
    if (range === 'all') {
        return { limit: Infinity, includeOther: false, label: 'All Labels' };
    }
    return { limit: 10, includeOther: false, label: 'Top 10' };
}

function getScopeEntities(scope, countKey) {
    if (scope.scopeKey === 'global' || scope.scopeKey === 'collection') {
        return scope.datasets.map(({ dataset }) => {
            const counts = aggregateDatasetCounts(dataset, countKey);
            return {
                label: formatDisplayName(dataset.name),
                counts,
                total: sumCounts(counts),
                uniqueCount: Object.keys(counts).length,
                top: getTopEntry(counts),
            };
        });
    }

    if (scope.scopeKey === 'dataset') {
        return scope.donors.map((donor) => {
            const counts = donor[countKey] || {};
            return {
                label: donor.name,
                counts,
                total: sumCounts(counts),
                uniqueCount: Object.keys(counts).length,
                top: getTopEntry(counts),
            };
        });
    }

    return [];
}

function getComparableEntityCount(scope) {
    if (scope.scopeKey === 'global' || scope.scopeKey === 'collection') {
        return scope.datasets.length;
    }
    if (scope.scopeKey === 'dataset') {
        return scope.donors.length;
    }
    return 0;
}

function getCellMetricAvailability(scope) {
    if (scope.scopeKey === 'donor') {
        return { composition: true, diversity: true, comparison: true };
    }

    const comparableEntityCount = getComparableEntityCount(scope);
    const supportsComparison = comparableEntityCount > 1;
    return {
        composition: true,
        diversity: supportsComparison,
        comparison: supportsComparison,
    };
}

function getRegionMetricAvailability(scope) {
    if (scope.scopeKey === 'donor') {
        return { composition: true, coverage: true, comparison: true };
    }

    const comparableEntityCount = getComparableEntityCount(scope);
    const supportsComparison = comparableEntityCount > 1;
    return {
        composition: true,
        coverage: supportsComparison,
        comparison: supportsComparison,
    };
}

function getSupportedMetric(activeMetric, availability) {
    if (availability[activeMetric]) {
        return activeMetric;
    }

    const fallbackMetric = Object.keys(availability).find((key) => availability[key]);
    return fallbackMetric || 'composition';
}

function buildDistributionModel(title, subtitle, counts, totalCells, options = {}) {
    const rangeOptions = getRangeOptions(options.range || 'top');
    const limit = options.limit ?? rangeOptions.limit;
    const includeOther = options.includeOther ?? rangeOptions.includeOther;
    const series = buildTopSeries(counts, totalCells, limit, includeOther);
    const colors = getSoftChartPalette(series.length);
    return {
        title,
        subtitle,
        insights: buildInsightCards([
            {
                label: 'Dominant Label',
                value: series[0]?.label || 'N/A',
                meta: series[0] ? `${series[0].count.toLocaleString()} cells · ${series[0].percentage.toFixed(1)}%` : 'No data',
            },
            {
                label: 'Visible Labels',
                value: `${series.length}`,
                meta: includeOther ? 'Includes aggregated tail' : rangeOptions.label,
            },
            {
                label: 'Total Cells',
                value: totalCells.toLocaleString(),
                meta: 'Current scope',
            },
        ]),
        chart: {
            type: 'bar',
            labels: series.map((item) => item.label),
            datasets: [{
                label: options.datasetLabel || 'Share of cells (%)',
                data: series.map((item) => item.percentage),
                counts: series.map((item) => item.count),
                backgroundColor: colors,
                borderColor: colors.map((color) => color.replace('0.82', '1')),
                borderWidth: 1.5,
            }],
            indexAxis: 'y',
        },
        rows: series.map((item) => ({
            label: item.label,
            value: `${item.count.toLocaleString()} cells`,
            meta: `${item.percentage.toFixed(1)}%`,
        })),
        showSupplementTable: Boolean(options.showSupplementTable),
    };
}

function buildBalanceModel(title, subtitle, counts, totalCells, label) {
    const ranked = sortCountEntries(counts);
    const top1 = ranked.slice(0, 1).reduce((sum, [, count]) => sum + count, 0);
    const top3 = ranked.slice(0, 3).reduce((sum, [, count]) => sum + count, 0);
    const remainder = Math.max(totalCells - top3, 0);
    const series = [
        { label: `Top 1 ${label}`, count: top1 },
        { label: `Top 3 ${label}s`, count: top3 },
        { label: 'Remaining Tail', count: remainder },
    ].map((item) => ({
        ...item,
        percentage: Number(formatShare(item.count, totalCells).replace('%', '')),
    }));
    const colors = getSoftChartPalette(series.length);

    return {
        title,
        subtitle,
        insights: buildInsightCards([
            {
                label: 'Dominant Share',
                value: `${series[0].percentage.toFixed(1)}%`,
                meta: ranked[0] ? ranked[0][0] : 'No dominant label',
            },
            {
                label: 'Top 3 Coverage',
                value: `${series[1].percentage.toFixed(1)}%`,
                meta: 'How concentrated the profile is',
            },
            {
                label: 'Tail Weight',
                value: `${series[2].percentage.toFixed(1)}%`,
                meta: 'Remaining long-tail contribution',
            },
        ]),
        chart: {
            type: 'bar',
            labels: series.map((item) => item.label),
            datasets: [{
                label: `${label} balance (%)`,
                data: series.map((item) => item.percentage),
                counts: series.map((item) => item.count),
                backgroundColor: colors,
                borderColor: colors.map((color) => color.replace('0.82', '1')),
                borderWidth: 1.5,
            }],
            indexAxis: 'y',
        },
        rows: series.map((item) => ({
            label: item.label,
            value: `${item.count.toLocaleString()} cells`,
            meta: `${item.percentage.toFixed(1)}%`,
        })),
    };
}

function buildCumulativeModel(title, subtitle, counts, totalCells, label) {
    const ranked = sortCountEntries(counts);
    let running = 0;
    const series = ranked.map(([entryLabel, count], index) => {
        running += count;
        return {
            label: `${index + 1}`,
            count,
            entryLabel,
            cumulative: Number(formatShare(running, totalCells).replace('%', '')),
        };
    });
    const lineColor = getSoftChartPalette(1)[0];

    return {
        title,
        subtitle,
        insights: buildInsightCards([
            {
                label: `Top 1 ${label}`,
                value: series[0] ? `${series[0].cumulative.toFixed(1)}%` : '0.0%',
                meta: 'Coverage after the first ranked label',
            },
            {
                label: `Top 3 ${label}s`,
                value: series[2] ? `${series[2].cumulative.toFixed(1)}%` : (series.at(-1) ? `${series.at(-1).cumulative.toFixed(1)}%` : '0.0%'),
                meta: 'Cumulative coverage at rank 3',
            },
            {
                label: 'Total Labels',
                value: `${series.length}`,
                meta: 'Full ranked profile',
            },
        ]),
        chart: {
            type: 'line',
            labels: series.map((item) => item.label),
            datasets: [{
                label: `Cumulative ${label.toLowerCase()} coverage (%)`,
                data: series.map((item) => item.cumulative),
                backgroundColor: lineColor,
                borderColor: lineColor.replace('0.82', '1'),
                pointBackgroundColor: lineColor.replace('0.82', '1'),
                pointBorderColor: '#f8fbfd',
                pointRadius: 3,
                pointHoverRadius: 4,
                fill: false,
            }],
        },
        rows: series.map((item) => ({
            label: `Rank ${item.label}`,
            value: item.entryLabel,
            meta: `${item.cumulative.toFixed(1)}% cumulative`,
        })),
    };
}

function buildDiversityModel(title, subtitle, entities, label) {
    const sortedEntities = [...entities].sort((left, right) => right.uniqueCount - left.uniqueCount);
    const colors = getSoftChartPalette(sortedEntities.length);
    return {
        title,
        subtitle,
        insights: buildInsightCards([
            {
                label: `Highest ${label}`,
                value: sortedEntities[0]?.label || 'N/A',
                meta: sortedEntities[0] ? `${sortedEntities[0].uniqueCount} unique labels` : 'No data',
            },
            {
                label: 'Compared Groups',
                value: `${sortedEntities.length}`,
                meta: 'Current scope',
            },
            {
                label: 'Average Diversity',
                value: sortedEntities.length
                    ? `${(sortedEntities.reduce((sum, entity) => sum + entity.uniqueCount, 0) / sortedEntities.length).toFixed(1)}`
                    : '0',
                meta: `Unique ${label.toLowerCase()}`,
            },
        ]),
        chart: {
            type: 'bar',
            labels: sortedEntities.map((item) => item.label),
            datasets: [{
                label: `Unique ${label}`,
                data: sortedEntities.map((item) => item.uniqueCount),
                backgroundColor: colors,
                borderColor: colors.map((color) => color.replace('0.82', '1')),
                borderWidth: 1.5,
            }],
            indexAxis: 'x',
        },
        rows: sortedEntities.map((item) => ({
            label: item.label,
            value: `${item.uniqueCount} unique labels`,
            meta: item.top ? `Dominant: ${item.top.label}` : 'No dominant label',
        })),
    };
}

function buildComparisonModel(title, subtitle, entities, dimensionLabel) {
    const visibleEntities = [...entities]
        .filter((entity) => entity.total > 0)
        .sort((left, right) => right.total - left.total)
        .slice(0, 8);
    const mergedCounts = {};
    visibleEntities.forEach((entity) => {
        dataModel.aggregateCounts(mergedCounts, entity.counts);
    });
    const topKeys = sortCountEntries(mergedCounts).slice(0, 5).map(([label]) => label);
    const colors = getSoftChartPalette(topKeys.length);

    return {
        title,
        subtitle,
        insights: buildInsightCards([
            {
                label: 'Compared Groups',
                value: `${visibleEntities.length}`,
                meta: `Grouped by ${dimensionLabel.toLowerCase()}`,
            },
            {
                label: 'Shared Labels',
                value: `${topKeys.length}`,
                meta: 'Top overlapping categories',
            },
            {
                label: 'Reference Label',
                value: topKeys[0] || 'N/A',
                meta: 'Most abundant overall',
            },
        ]),
        chart: {
            type: 'bar',
            labels: visibleEntities.map((entity) => entity.label),
            datasets: topKeys.map((key, index) => ({
                label: key,
                data: visibleEntities.map((entity) => Number(((entity.counts[key] || 0) / Math.max(entity.total, 1) * 100).toFixed(1))),
                backgroundColor: colors[index],
                borderColor: colors[index].replace('0.82', '1'),
                borderWidth: 1.2,
            })),
            indexAxis: 'x',
            stacked: true,
        },
        rows: visibleEntities.map((entity) => ({
            label: entity.label,
            value: entity.top ? entity.top.label : 'N/A',
            meta: entity.top ? `${entity.top.count.toLocaleString()} cells dominant` : 'No dominant label',
        })),
    };
}

function getCellMetricLabels(scopeKey) {
    if (scopeKey === 'dataset') {
        return {
            composition: 'Composition',
            diversity: 'Donor Diversity',
            comparison: 'Donor Comparison',
        };
    }
    if (scopeKey === 'donor') {
        return {
            composition: 'Composition',
            diversity: 'Balance',
            comparison: 'Cumulative',
        };
    }
    return {
        composition: 'Composition',
        diversity: 'Dataset Diversity',
        comparison: 'Dataset Comparison',
    };
}

function getRegionMetricLabels(scopeKey) {
    if (scopeKey === 'dataset') {
        return {
            composition: 'Composition',
            coverage: 'Donor Coverage',
            comparison: 'Donor Comparison',
        };
    }
    if (scopeKey === 'donor') {
        return {
            composition: 'Composition',
            coverage: 'Balance',
            comparison: 'Coverage',
        };
    }
    return {
        composition: 'Composition',
        coverage: 'Dataset Coverage',
        comparison: 'Dataset Comparison',
    };
}

function syncMetricToggle(prefix, labels, activeMetric, availability = {}) {
    const mapping = [
        ['Primary', 'composition'],
        ['Secondary', prefix === 'cell' ? 'diversity' : 'coverage'],
        ['Tertiary', 'comparison'],
    ];
    mapping.forEach(([slot, key]) => {
        const button = document.getElementById(`${prefix}Metric${slot}Btn`);
        if (!button) {
            return;
        }
        button.textContent = labels[key];
        const enabled = availability[key] !== false;
        button.disabled = !enabled;
        button.classList.toggle('active', activeMetric === key && enabled);
    });
}

function syncRangeToggle(prefix, activeRange, enabled) {
    const mapping = [
        ['Top', 'top'],
        ['Other', 'other'],
        ['All', 'all'],
    ];
    mapping.forEach(([slot, key]) => {
        const button = document.getElementById(`${prefix}Range${slot}Btn`);
        if (!button) {
            return;
        }
        button.classList.toggle('active', activeRange === key && enabled);
        button.disabled = !enabled;
    });
}

function renderMetricRows(containerId, rows, emptyMessage, classPrefix) {
    const container = document.getElementById(containerId);
    if (!rows.length) {
        container.innerHTML = `<div class="no-data">${emptyMessage}</div>`;
        return;
    }

    container.innerHTML = rows.map((row) => `
        <div class="${classPrefix}-row">
            <span class="${classPrefix}-name">${row.label}</span>
            <div>
                <span class="${classPrefix}-count">${row.value}</span>
                ${row.meta ? `<span class="${classPrefix}-percentage">${row.meta}</span>` : ''}
            </div>
        </div>
    `).join('');
}

function setChartContainerHeight(containerId, rowCount, indexAxis = 'y') {
    const container = document.getElementById(containerId);
    if (!container) {
        return;
    }

    if (indexAxis === 'y') {
        const nextHeight = Math.max(300, Math.min(760, 84 + (rowCount * 34)));
        container.style.height = `${nextHeight}px`;
        return;
    }

    container.style.height = '320px';
}

function buildCellMetricModel(scope) {
    const labels = getCellMetricLabels(scope.scopeKey);
    const availability = getCellMetricAvailability(scope);
    currentCellMetric = getSupportedMetric(currentCellMetric, availability);
    syncMetricToggle('cell', labels, currentCellMetric, availability);
    syncRangeToggle('cell', currentCellRange, currentCellMetric === 'composition');

    if (scope.scopeKey === 'donor') {
        if (currentCellMetric === 'diversity') {
            return buildBalanceModel(
                `Cell Type Balance · ${scope.scopeLabel}`,
                'How strongly this donor is dominated by a few cell types versus the long tail.',
                scope.cellTypeCounts,
                scope.metrics.cells,
                'Cell Type'
            );
        }

        if (currentCellMetric === 'comparison') {
            return buildCumulativeModel(
                `Cell Type Cumulative Coverage · ${scope.scopeLabel}`,
                'Cumulative share captured as ranked cell types are added from most to least abundant.',
                scope.cellTypeCounts,
                scope.metrics.cells,
                'Cell Type'
            );
        }

        return buildDistributionModel(
            `Cell Type Distribution · ${scope.scopeLabel}`,
            'Primary cell-type composition for the current donor.',
            scope.cellTypeCounts,
            scope.metrics.cells,
            {
                range: currentCellRange,
                showSupplementTable: currentCellRange === 'all',
            }
        );
    }

    if (currentCellMetric === 'composition') {
        return buildDistributionModel(
            `Cell Type Distribution · ${scope.scopeLabel}`,
            'Top cell-type composition ranked by share of cells in the current scope.',
            scope.cellTypeCounts,
            scope.metrics.cells,
            { range: currentCellRange }
        );
    }

    const entities = getScopeEntities(scope, 'cell_type_count');
    if (currentCellMetric === 'diversity') {
        return buildDiversityModel(
            `Cell Type Diversity · ${scope.scopeLabel}`,
            `Unique cell-type coverage across ${scope.scopeKey === 'dataset' ? 'donors' : 'datasets'}.`,
            entities,
            'Cell Types'
        );
    }

    return buildComparisonModel(
        `Cell Type Comparison · ${scope.scopeLabel}`,
        `Normalized top cell-type profiles across ${scope.scopeKey === 'dataset' ? 'donors' : 'datasets'}.`,
        entities,
        scope.scopeKey === 'dataset' ? 'Donor' : 'Dataset'
    );
}

function buildRegionMetricModel(scope) {
    const labels = getRegionMetricLabels(scope.scopeKey);
    const availability = getRegionMetricAvailability(scope);
    currentRegionMetric = getSupportedMetric(currentRegionMetric, availability);
    syncMetricToggle('region', labels, currentRegionMetric, availability);
    syncRangeToggle('region', currentRegionRange, currentRegionMetric === 'composition');

    const countKey = currentRegionType === 'brodmann' ? 'brod_count' : 'gyral_count';
    const regionLabel = currentRegionType === 'brodmann' ? 'Brodmann' : 'Gyral';
    const counts = countKey === 'brod_count' ? scope.brodCounts : scope.gyralCounts;
    const totalCells = sumCounts(counts);

    if (scope.scopeKey === 'donor') {
        if (currentRegionMetric === 'coverage') {
            return buildBalanceModel(
                `${regionLabel} Region Balance · ${scope.scopeLabel}`,
                `How concentrated this donor is within a few ${regionLabel.toLowerCase()} annotations.`,
                counts,
                totalCells,
                regionLabel
            );
        }

        if (currentRegionMetric === 'comparison') {
            return buildCumulativeModel(
                `${regionLabel} Region Coverage · ${scope.scopeLabel}`,
                `Cumulative coverage captured as ranked ${regionLabel.toLowerCase()} annotations are added.`,
                counts,
                totalCells,
                regionLabel
            );
        }

        return buildDistributionModel(
            `${regionLabel} Region Distribution · ${scope.scopeLabel}`,
            `Primary ${regionLabel.toLowerCase()} region composition for this donor.`,
            counts,
            totalCells,
            { range: currentRegionRange }
        );
    }

    if (currentRegionMetric === 'composition') {
        return buildDistributionModel(
            `${regionLabel} Region Distribution · ${scope.scopeLabel}`,
            `Top ${regionLabel.toLowerCase()} regions ranked by share of cells in the current scope.`,
            counts,
            totalCells,
            { range: currentRegionRange }
        );
    }

    const entities = getScopeEntities(scope, countKey);
    if (currentRegionMetric === 'coverage') {
        return buildDiversityModel(
            `${regionLabel} Coverage · ${scope.scopeLabel}`,
            `Unique ${regionLabel.toLowerCase()} region coverage across ${scope.scopeKey === 'dataset' ? 'donors' : 'datasets'}.`,
            entities,
            `${regionLabel} Regions`
        );
    }

    return buildComparisonModel(
        `${regionLabel} Comparison · ${scope.scopeLabel}`,
        `Normalized top ${regionLabel.toLowerCase()} region profiles across ${scope.scopeKey === 'dataset' ? 'donors' : 'datasets'}.`,
        entities,
        scope.scopeKey === 'dataset' ? 'Donor' : 'Dataset'
    );
}

function renderCellTypeTable(model) {
    renderMetricRows('cellTableView', model.rows, 'No cell type data available', 'cell');
}

function renderCellTypeSection(scope) {
    const hasData = Object.keys(scope.cellTypeCounts).length > 0;
    if (!hasData) {
        document.getElementById('cellTypeSection').classList.add('hidden');
        destroyCellTypeChart();
        return;
    }

    const model = buildCellMetricModel(scope);
    setText('cellTypeTitle', model.title);
    setText('cellTypeSubtitle', model.subtitle);
    document.getElementById('cellTypeInsights').innerHTML = model.insights;
    document.getElementById('cellTypeSection').classList.remove('hidden');
    const cellContent = document.querySelector('#cellTypeSection .cell-type-content');
    const showSupplementTable = currentCellView === 'chart' && model.showSupplementTable;
    const chartView = document.getElementById('cellChartView');
    const tableView = document.getElementById('cellTableView');
    cellContent.classList.toggle('cell-type-content--split', showSupplementTable);
    chartView.classList.toggle('hidden', currentCellView !== 'chart');
    tableView.classList.toggle('hidden', currentCellView !== 'table' && !showSupplementTable);

    if (currentCellView === 'chart') {
        setChartContainerHeight('cellChartView', model.rows.length, model.chart.indexAxis || 'x');
        renderCellMetricChart(model.chart);
        if (showSupplementTable) {
            renderCellTypeTable(model);
        }
    } else {
        renderCellTypeTable(model);
    }
}

function renderRegionTable(model) {
    renderMetricRows('regionsTable', model.rows, 'No region data available', 'region');
}

function renderBrainRegions(scope) {
    const hasData = Object.keys(currentRegionType === 'brodmann' ? scope.brodCounts : scope.gyralCounts).length > 0;
    if (!hasData) {
        document.getElementById('brainRegionsSection').classList.add('hidden');
        destroyRegionChart();
        return;
    }

    const model = buildRegionMetricModel(scope);
    setText('regionsTitle', model.title);
    setText('regionsSubtitle', model.subtitle);
    document.getElementById('regionInsights').innerHTML = model.insights;
    document.getElementById('brainRegionsSection').classList.remove('hidden');
    renderRegionTable(model);
    setChartContainerHeight('regionChartView', model.rows.length, model.chart.indexAxis || 'x');
    renderRegionMetricChart(model.chart);
}

function updateView(collectionId, datasetId, donorId) {
    setSelection(collectionId, datasetId, donorId);
    hideAllSections();

    const globalScope = getScopeState('', '', '');
    const selectedScope = getScopeState(collectionId, datasetId, donorId);
    renderScopeBanner(selectedScope);

    if (window.AtlasBridge) {
        window.AtlasBridge.sync(selectedScope, { collectionId, datasetId, donorId });
    }

    if (!collectionId) {
        renderCollectionOverview(globalScope, 'Global Overview');
        renderCellTypeSection(globalScope);
        renderBrainRegions(globalScope);
        return;
    }

    const collectionScope = getScopeState(collectionId, '', '');
    renderCollectionOverview(collectionScope, `Collection Overview · ${collectionScope.scopeLabel}`);

    if (!datasetId) {
        renderCellTypeSection(collectionScope);
        renderBrainRegions(collectionScope);
        return;
    }

    const datasetScope = getScopeState(collectionId, datasetId, '');
    renderDatasetOverview(datasetScope);

    if (!donorId) {
        renderCellTypeSection(datasetScope);
        renderBrainRegions(datasetScope);
        return;
    }

    const donorScope = getScopeState(collectionId, datasetId, donorId);
    renderDonorDetails(donorScope);
    renderCellTypeSection(donorScope);
    renderBrainRegions(donorScope);
}

function switchRegionType(type) {
    currentRegionType = type;
    document.getElementById('brodmannBtn').classList.toggle('active', type === 'brodmann');
    document.getElementById('gyralBtn').classList.toggle('active', type === 'gyral');

    const { collectionId, datasetId, donorId } = getSelection();
    updateView(collectionId, datasetId, donorId);
}

function switchRegionMetric(metric) {
    currentRegionMetric = metric;
    const { collectionId, datasetId, donorId } = getSelection();
    updateView(collectionId, datasetId, donorId);
}

function switchRegionRange(range) {
    currentRegionRange = range;
    const { collectionId, datasetId, donorId } = getSelection();
    updateView(collectionId, datasetId, donorId);
}

function switchCellView(view) {
    currentCellView = view;
    document.getElementById('cellChartBtn').classList.toggle('active', view === 'chart');
    document.getElementById('cellTableBtn').classList.toggle('active', view === 'table');
    document.getElementById('cellChartView').classList.toggle('hidden', view !== 'chart');
    document.getElementById('cellTableView').classList.toggle('hidden', view !== 'table');

    const { collectionId, datasetId, donorId } = getSelection();
    updateView(collectionId, datasetId, donorId);
}

function switchCellMetric(metric) {
    currentCellMetric = metric;
    const { collectionId, datasetId, donorId } = getSelection();
    updateView(collectionId, datasetId, donorId);
}

function switchCellRange(range) {
    currentCellRange = range;
    const { collectionId, datasetId, donorId } = getSelection();
    updateView(collectionId, datasetId, donorId);
}
