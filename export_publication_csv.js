#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const DEFAULT_DATA_FILE = path.join(ROOT, 'digitalneuron_data.js');
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'publication_csv');

function loadFrontendData(dataFile) {
    const source = fs.readFileSync(dataFile, 'utf8');
    const sandbox = {
        window: {},
        console,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: dataFile });

    const data = sandbox.window.currentData || sandbox.currentData || sandbox.digitalNeuronData || sandbox.sampleData;
    if (!data || typeof data !== 'object') {
        throw new Error(`No frontend data object found in ${dataFile}`);
    }
    return data;
}

function aggregateCounts(target, source) {
    Object.entries(source || {}).forEach(([label, rawCount]) => {
        const count = Number(rawCount || 0);
        if (count > 0) {
            target[label] = (target[label] || 0) + count;
        }
    });
}

function collectGlobalCounts(data) {
    const cellTypeCounts = {};
    const brodmannCounts = {};
    const gyralCounts = {};
    let totalCells = 0;
    let collectionCount = 0;
    let datasetCount = 0;
    let donorCount = 0;

    Object.values(data).forEach((collection) => {
        collectionCount += 1;
        Object.values(collection.datasets || {}).forEach((dataset) => {
            datasetCount += 1;
            Object.values(dataset.donors || {}).forEach((donor) => {
                donorCount += 1;
                totalCells += Number(donor.cells || 0);
                aggregateCounts(cellTypeCounts, donor.cell_type_count);
                aggregateCounts(brodmannCounts, donor.brod_count);
                aggregateCounts(gyralCounts, donor.gyral_count);
            });
        });
    });

    return {
        cellTypeCounts,
        brodmannCounts,
        gyralCounts,
        totalCells,
        collectionCount,
        datasetCount,
        donorCount,
    };
}

function csvEscape(value) {
    const text = String(value ?? '');
    if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function writeCsv(filePath, headers, rows) {
    const lines = [
        headers.join(','),
        ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
    ];
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function distributionRows(counts, denominator, fields) {
    return Object.entries(counts)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([label, count], index) => ({
            rank: index + 1,
            ...fields(label),
            count,
            total_count: denominator,
            percentage: denominator > 0 ? Number(((count / denominator) * 100).toFixed(6)) : 0,
        }));
}

function main() {
    const dataFile = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DATA_FILE;
    const outputDir = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_OUTPUT_DIR;
    fs.mkdirSync(outputDir, { recursive: true });

    const data = loadFrontendData(dataFile);
    const totals = collectGlobalCounts(data);

    const cellTypeTotal = Object.values(totals.cellTypeCounts).reduce((sum, count) => sum + count, 0);
    const brodmannTotal = Object.values(totals.brodmannCounts).reduce((sum, count) => sum + count, 0);
    const gyralTotal = Object.values(totals.gyralCounts).reduce((sum, count) => sum + count, 0);

    const cellRows = distributionRows(totals.cellTypeCounts, cellTypeTotal, (label) => ({
        scope: 'All Collections',
        category: 'cell_type',
        label,
    }));

    const regionRows = [
        ...distributionRows(totals.brodmannCounts, brodmannTotal, (label) => ({
            scope: 'All Collections',
            region_annotation: 'Brodmann',
            region_label: label,
        })),
        ...distributionRows(totals.gyralCounts, gyralTotal, (label) => ({
            scope: 'All Collections',
            region_annotation: 'Gyral',
            region_label: label,
        })),
    ];

    const metadataRows = [
        { metric: 'source_data_file', value: path.relative(ROOT, dataFile) },
        { metric: 'scope', value: 'All Collections' },
        { metric: 'collections', value: totals.collectionCount },
        { metric: 'datasets', value: totals.datasetCount },
        { metric: 'donors', value: totals.donorCount },
        { metric: 'total_cells_declared_by_donors', value: totals.totalCells },
        { metric: 'cell_type_count_sum', value: cellTypeTotal },
        { metric: 'brodmann_region_count_sum', value: brodmannTotal },
        { metric: 'gyral_region_count_sum', value: gyralTotal },
        { metric: 'percentage_precision', value: 'six decimal places' },
    ];

    const cellFile = path.join(outputDir, 'cell_type_distribution.csv');
    const regionFile = path.join(outputDir, 'brain_region_distribution.csv');
    const metadataFile = path.join(outputDir, 'export_metadata.csv');

    writeCsv(cellFile, ['rank', 'scope', 'category', 'label', 'count', 'total_count', 'percentage'], cellRows);
    writeCsv(regionFile, ['rank', 'scope', 'region_annotation', 'region_label', 'count', 'total_count', 'percentage'], regionRows);
    writeCsv(metadataFile, ['metric', 'value'], metadataRows);

    console.log(`Wrote ${cellRows.length} cell-type rows to ${path.relative(ROOT, cellFile)}`);
    console.log(`Wrote ${regionRows.length} brain-region rows to ${path.relative(ROOT, regionFile)}`);
    console.log(`Wrote metadata to ${path.relative(ROOT, metadataFile)}`);
}

main();
