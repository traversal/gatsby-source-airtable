const Airtable = require("airtable");
const crypto = require(`crypto`);
const { createRemoteFileNode } = require(`gatsby-source-filesystem`);

exports.sourceNodes = async (
  { actions, createNodeId, store, cache },
  { apiKey, tables, splitTables, omitRaw }
) => {
  // tables contain baseId, tableName, tableView, queryName, mapping, tableLinks
  const { createNode, setPluginStatus } = actions;

  try {
    // hoist api so we can use in scope outside of this block
    var api = await new Airtable({
      apiKey: process.env.GATSBY_AIRTABLE_API_KEY || apiKey
    });
  } catch (e) {
    // airtable uses `assert` which doesn't exit the process,
    //  but rather just makes gatsby hang. Warn, don't create any
    //  nodes, but let gatsby continue working
    console.warn("\nAPI key is required to connect to Airtable");
    return;
  }

  // exit if tables is not defined
  if (tables === undefined || tables.length === 0) {
    console.warn(
      "\ntables is not defined for gatsby-source-airtable in gatsby-config.js"
    );
    return;
  }

  console.time(`\nfetch all Airtable rows from ${tables.length} tables`);

  let queue = [];
  tables.forEach(tableOptions => {
    let base = api.base(tableOptions.baseId);

    let table = base(tableOptions.tableName);

    let query = table.select({
      view: tableOptions.tableView
    });

    // query.all() returns a promise, pass an array for each table with
    // both our promise and the queryName and then map reduce at the
    // final promise resolution to get queryName onto each row
    queue.push(
      Promise.all([
        query.all(),
        tableOptions.queryName,
        tableOptions.mapping,
        tableOptions.tableLinks,
        tableOptions.tableName
      ])
    );
  });

  // queue has array of promises and when resolved becomes nested arrays
  // we flatten the array to return all rows from all tables after mapping
  // the queryName to each row
  const allRows = await Promise.all(queue)
    .then(all => {
      return all.reduce((accumulator, currentValue) => {
        return accumulator.concat(
          currentValue[0].map(row => {
            row.queryName = currentValue[1]; // queryName from tableOptions above
            row.mapping = currentValue[2]; // mapping from tableOptions above
            row.tableLinks = currentValue[3]; // tableLinks from tableOptions above
            row.tableName = currentValue[4]; // tableName from tableOptions above
            return row;
          })
        );
      }, []);
    })
    .catch(e => {
      throw e;
      return;
    });

  console.timeEnd(`\nfetch all Airtable rows from ${tables.length} tables`);

  setPluginStatus({
    status: {
      lastFetched: new Date().toJSON()
    }
  });

  let childNodes = allRows.map(async row => {

    const upperFirst = (str) => str.charAt(0).toUpperCase() + str.slice(1);
    const tableSuffix = splitTables ? upperFirst(row.tableName.replace(/[^a-z]/ig, '')) : '';

    let processedData = await processData(row, {
      createNodeId,
      createNode,
      store,
      cache,
      tableSuffix,
      omitRaw,
    });

    const node = {
      id: createNodeId(`Airtable_${row.id}`),
      parent: null,
      table: row.tableName,
      queryName: row.queryName,
      children: [],
      internal: {
        type: `Airtable${tableSuffix}`,
        contentDigest: crypto
          .createHash("md5")
          .update(JSON.stringify(row))
          .digest("hex")
      },
      data: processedData.data
    };

    createNode(node);
    return processedData.childNodes;
  });

  let flattenedChildNodes = Promise.all(childNodes).then(nodes =>
    nodes.reduce(
      (accumulator, currentValue) => accumulator.concat(currentValue),
      []
    )
  );

  return Promise.all(flattenedChildNodes).then(nodes => {
    nodes.forEach(node => createNode(node));
  });
};

const processData = async (row, { createNodeId, createNode, store, cache, tableSuffix, omitRaw }) => {
  let data = row.fields;
  let tableLinks = row.tableLinks;

  let fieldKeys = Object.keys(data);
  let processedData = {};
  let childNodes = [];

  await fieldKeys.forEach(key => {
    let useKey;
    // deals with airtable linked fields,
    // these will be airtable IDs
    if (tableLinks && tableLinks.includes(key)) {
      useKey = `${cleanKey(key)}___NODE`;
      processedData[useKey] = data[key].map(id =>
        createNodeId(`Airtable_${id}`)
      );
      // A child node comes from the mapping, where we want to
      // define a separate node in gatsby that is available
      // for transforming. This will let other plugins pick
      // up on that node to add nodes.
    } else {
      if (row.mapping && row.mapping[key]) {
        let checkedChildNode = checkChildNode(key, row, processedData, {
          createNodeId,
          createNode,
          store,
          cache,
          tableSuffix,
          omitRaw,
        });
        childNodes.push(checkedChildNode);
      } else {
        processedData[cleanKey(key)] = data[key];
      }
    }
  });

  // where childNodes returns an array of objects
  return { data: processedData, childNodes: childNodes };
};

const checkChildNode = async (
  key,
  row,
  processedData,
  { createNodeId, createNode, store, cache, tableSuffix, omitRaw }
) => {
  let data = row.fields;
  let mapping = row.mapping;
  let cleanedKey = cleanKey(key);
  let localFiles = await localFileCheck(key, row, {
    createNodeId,
    createNode,
    store,
    cache
  });

  processedData[`${cleanedKey}___NODE`] = createNodeId(
    `AirtableField_${row.id}_${cleanedKey}`
  );

  return buildNode(
    localFiles,
    row,
    cleanedKey,
    data[key],
    mapping[key],
    createNodeId,
    tableSuffix,
    omitRaw,
  );
};

const localFileCheck = async (
  key,
  row,
  { createNodeId, createNode, store, cache }
) => {
  let data = row.fields;
  let mapping = row.mapping;
  if (mapping[key] === `fileNode`) {
    try {
      let fileNodes = [];
      // where data[key] is the array of attachments
      data[key].forEach(attachment => {
        let attachmentNode = createRemoteFileNode({
          url: attachment.url,
          store,
          cache,
          createNode,
          createNodeId
        });
        fileNodes.push(attachmentNode);
      });
      // Adds a field `localFile` to the node
      // ___NODE tells Gatsby that this field will link to another nodes
      let localFiles = await Promise.all(fileNodes).map(
        attachmentNode => attachmentNode.id
      );
      return localFiles;
    } catch (e) {
      console.log(
        "You specified a fileNode, but we caught an error. First check that you have gatsby-source-filesystem installed?\n",
        e
      );
    }
  }
  return;
};

const buildNode = (localFiles, row, cleanedKey, raw, mapping, createNodeId, tableSuffix, omitRaw) => {
  if (localFiles) {
    return {
      id: createNodeId(`AirtableField_${row.id}_${cleanedKey}`),
      parent: createNodeId(`Airtable_${row.id}`),
      children: [],
      raw: omitRaw ? null : raw,
      localFiles___NODE: localFiles,
      internal: {
        type: `AirtableField${tableSuffix}`,
        mediaType: mapping,
        content: typeof raw === 'string' ? raw : JSON.stringify(raw),
        contentDigest: crypto
          .createHash("md5")
          .update(JSON.stringify(row))
          .digest("hex")
      }
    };
  } else {
    return {
      id: createNodeId(`AirtableField_${row.id}_${cleanedKey}`),
      parent: createNodeId(`Airtable_${row.id}`),
      children: [],
      raw: omitRaw ? null : raw,
      internal: {
        type: `AirtableField${tableSuffix}`,
        mediaType: mapping,
        content: typeof raw === 'string' ? raw : JSON.stringify(raw),
        contentDigest: crypto
          .createHash("md5")
          .update(JSON.stringify(row))
          .digest("hex")
      }
    };
  }
};

const cleanKey = (key, data) => {
  return key.replace(/ /g, "_");
};
