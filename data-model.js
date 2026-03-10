(function (global) {
    function toArray(value) {
        return Array.isArray(value) ? value : [];
    }

    function sortStrings(values) {
        return [...values].sort((left, right) => left.localeCompare(right));
    }

    function aggregateCounts(target, source) {
        if (!source) {
            return target;
        }
        Object.entries(source).forEach(([key, value]) => {
            target[key] = (target[key] || 0) + value;
        });
        return target;
    }

    function uniquePush(targetSet, values) {
        toArray(values).forEach((value) => {
            if (value) {
                targetSet.add(value);
            }
        });
    }

    function getCollections(data) {
        return Object.entries(data || {}).map(([id, collection]) => ({
            id,
            name: collection.name,
            datasets: collection.datasets || {},
        }));
    }

    function getDatasets(data, collectionId) {
        const collection = data?.[collectionId];
        if (!collection) {
            return [];
        }
        return Object.entries(collection.datasets || {}).map(([id, dataset]) => ({
            id,
            name: dataset.name,
            donors: dataset.donors || {},
        }));
    }

    function getDonorOptions(data, collectionId, datasetId) {
        const dataset = data?.[collectionId]?.datasets?.[datasetId];
        if (!dataset) {
            return [];
        }
        return Object.entries(dataset.donors || {}).map(([id, donor]) => {
            const age = donor.age?.[0] || 'N/A';
            const gender = donor.gender?.[0] || 'N/A';
            return {
                id,
                donor,
                label: `${donor.name} (${Number(donor.cells || 0).toLocaleString()} cells, ${age}, ${gender})`,
            };
        });
    }

    function listScopeDatasets(data, collectionId, datasetId) {
        if (!collectionId) {
            return getCollections(data).flatMap((collection) =>
                Object.entries(collection.datasets).map(([id, dataset]) => ({
                    collectionId: collection.id,
                    collectionName: collection.name,
                    datasetId: id,
                    dataset,
                }))
            );
        }

        if (!datasetId) {
            return getDatasets(data, collectionId).map(({ id, name, donors }) => ({
                collectionId,
                collectionName: data[collectionId].name,
                datasetId: id,
                dataset: { name, donors },
            }));
        }

        const dataset = data?.[collectionId]?.datasets?.[datasetId];
        if (!dataset) {
            return [];
        }
        return [
            {
                collectionId,
                collectionName: data[collectionId].name,
                datasetId,
                dataset,
            },
        ];
    }

    function listScopeDonors(data, collectionId, datasetId, donorId) {
        if (donorId) {
            const donor = data?.[collectionId]?.datasets?.[datasetId]?.donors?.[donorId];
            return donor ? [donor] : [];
        }

        return listScopeDatasets(data, collectionId, datasetId).flatMap(({ dataset }) =>
            Object.values(dataset.donors || {})
        );
    }

    function buildMetrics(datasets, donors) {
        return {
            datasets: datasets.length,
            donors: donors.length,
            cells: donors.reduce((sum, donor) => sum + Number(donor.cells || 0), 0),
            brodmannRegions: new Set(donors.flatMap((donor) => toArray(donor.brain_regions_brod))).size,
            gyralRegions: new Set(donors.flatMap((donor) => toArray(donor.brain_regions_gyral))).size,
        };
    }

    function computeScopeState(data, collectionId, datasetId, donorId) {
        const datasets = listScopeDatasets(data, collectionId, datasetId);
        const donors = listScopeDonors(data, collectionId, datasetId, donorId);

        const statusSet = new Set();
        const brodmannSet = new Set();
        const gyralSet = new Set();
        const cellTypeCounts = {};
        const brodCounts = {};
        const gyralCounts = {};

        donors.forEach((donor) => {
            uniquePush(statusSet, donor.status);
            uniquePush(brodmannSet, donor.brain_regions_brod);
            uniquePush(gyralSet, donor.brain_regions_gyral);
            aggregateCounts(cellTypeCounts, donor.cell_type_count);
            aggregateCounts(brodCounts, donor.brod_count);
            aggregateCounts(gyralCounts, donor.gyral_count);
        });

        let scopeKey = 'global';
        let scopeLabel = 'All Collections';
        if (collectionId && !datasetId && !donorId) {
            scopeKey = 'collection';
            scopeLabel = data?.[collectionId]?.name || collectionId;
        } else if (collectionId && datasetId && !donorId) {
            scopeKey = 'dataset';
            scopeLabel = data?.[collectionId]?.datasets?.[datasetId]?.name || datasetId;
        } else if (collectionId && datasetId && donorId) {
            scopeKey = 'donor';
            scopeLabel = data?.[collectionId]?.datasets?.[datasetId]?.donors?.[donorId]?.name || donorId;
        }

        return {
            scopeKey,
            scopeLabel,
            collectionId,
            datasetId,
            donorId,
            datasets,
            donors,
            metrics: buildMetrics(datasets, donors),
            statuses: sortStrings(statusSet),
            brodmannRegions: sortStrings(brodmannSet),
            gyralRegions: sortStrings(gyralSet),
            cellTypeCounts,
            brodCounts,
            gyralCounts,
        };
    }

    const api = {
        aggregateCounts,
        computeScopeState,
        getCollections,
        getDatasets,
        getDonorOptions,
        listScopeDatasets,
        listScopeDonors,
    };

    global.DigitalNeuronModel = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : window);
