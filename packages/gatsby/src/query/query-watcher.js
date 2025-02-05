/** *
 * Jobs of this module
 * - Maintain the list of components in the Redux store. So monitor new components
 *   and add/remove components.
 * - Watch components for query changes and extract these and update the store.
 * - Ensure all page queries are run as part of bootstrap and report back when
 *   this is done
 * - Whenever a query changes, re-run all pages that rely on this query.
 ***/

const _ = require(`lodash`)
const chokidar = require(`chokidar`)

const path = require(`path`)
const { slash } = require(`gatsby-core-utils`)

const { store, emitter } = require(`../redux/`)
const { boundActionCreators } = require(`../redux/actions`)
const queryCompiler = require(`./query-compiler`).default
const report = require(`gatsby-cli/lib/reporter`)
const queryUtil = require(`./index`)
const debug = require(`debug`)(`gatsby:query-watcher`)
const getGatsbyDependents = require(`../utils/gatsby-dependents`)

const getQueriesSnapshot = () => {
  const state = store.getState()

  const snapshot = {
    components: new Map(state.components),
    staticQueryComponents: new Map(state.staticQueryComponents),
  }

  return snapshot
}

const handleComponentsWithRemovedQueries = (
  { components, staticQueryComponents },
  queries
) => {
  // If a component had static query and it doesn't have it
  // anymore - update the store
  staticQueryComponents.forEach(c => {
    if (c.query !== `` && !queries.has(c.componentPath)) {
      debug(`Static query was removed from ${c.componentPath}`)
      store.dispatch({
        type: `REMOVE_STATIC_QUERY`,
        payload: c.id,
      })
      boundActionCreators.deleteComponentsDependencies([c.id])
    }
  })
}

const handleQuery = (
  { components, staticQueryComponents },
  query,
  component
) => {
  // If this is a static query
  // Add action / reducer + watch staticquery files
  if (query.isStaticQuery) {
    const oldQuery = staticQueryComponents.get(query.id)
    const isNewQuery = !oldQuery

    // Compare query text because text is compiled query with any attached
    // fragments and we want to rerun queries if fragments are edited.
    // Compare hash because hash is used for identyfing query and
    // passing data to component in development. Hash can change if user will
    // format query text, but it doesn't mean that compiled text will change.
    if (
      isNewQuery ||
      oldQuery.hash !== query.hash ||
      oldQuery.text !== query.text
    ) {
      boundActionCreators.replaceStaticQuery({
        name: query.name,
        componentPath: query.path,
        id: query.id,
        query: query.text,
        hash: query.hash,
      })

      debug(
        `Static query in ${component} ${
          isNewQuery ? `was added` : `has changed`
        }.`
      )

      boundActionCreators.deleteComponentsDependencies([query.id])
      queryUtil.enqueueExtractedQueryId(query.id)
    }
    return true
  }

  return false
}

const updateStateAndRunQueries = (isFirstRun, { parentSpan } = {}) => {
  const snapshot = getQueriesSnapshot()
  return queryCompiler({ parentSpan }).then(queries => {
    // If there's an error while extracting queries, the queryCompiler returns false
    // or zero results.
    // Yeah, should probably be an error but don't feel like threading the error
    // all the way here.
    if (!queries || queries.size === 0) {
      return null
    }
    handleComponentsWithRemovedQueries(snapshot, queries)

    // Run action for each component
    const { components } = snapshot
    components.forEach(c =>
      boundActionCreators.queryExtracted({
        componentPath: c.componentPath,
        query: queries.get(c.componentPath)?.text || ``,
      })
    )

    let queriesWillNotRun = false
    queries.forEach((query, component) => {
      const queryWillRun = handleQuery(snapshot, query, component)

      if (queryWillRun) {
        watchComponent(component)
        // Check if this is a page component.
        // If it is and this is our first run during bootstrap,
        // show a warning about having a query in a non-page component.
      } else if (isFirstRun && !snapshot.components.has(component)) {
        report.warn(
          `The GraphQL query in the non-page component "${component}" will not be run.`
        )
        queriesWillNotRun = true
      }
    })

    if (queriesWillNotRun) {
      report.log(report.stripIndent`

        Exported queries are only executed for Page components. It's possible you're
        trying to create pages in your gatsby-node.js and that's failing for some
        reason.

        If the failing component(s) is a regular component and not intended to be a page
        component, you generally want to use a <StaticQuery> (https://gatsbyjs.org/docs/static-query)
        instead of exporting a page query.

        If you're more experienced with GraphQL, you can also export GraphQL
        fragments from components and compose the fragments in the Page component
        query and pass data down into the child component — http://graphql.org/learn/queries/#fragments

      `)
    }

    queryUtil.runQueuedQueries()

    return null
  })
}

/**
 * Removes components templates that aren't used by any page from redux store.
 */
const clearInactiveComponents = () => {
  const { components, pages } = store.getState()

  const activeTemplates = new Set()
  pages.forEach(page => {
    // Set will guarantee uniqeness of entires
    activeTemplates.add(slash(page.component))
  })

  components.forEach(component => {
    if (!activeTemplates.has(component.componentPath)) {
      debug(
        `${component.componentPath} component was removed because it isn't used by any page`
      )
      store.dispatch({
        type: `REMOVE_TEMPLATE_COMPONENT`,
        payload: component,
      })
    }
  })
}

exports.extractQueries = ({ parentSpan } = {}) => {
  // Remove template components that point to not existing page templates.
  // We need to do this, because components data is cached and there might
  // be changes applied when development server isn't running. This is needed
  // only in initial run, because during development state will be adjusted.
  clearInactiveComponents()

  return updateStateAndRunQueries(true, { parentSpan }).then(() => {
    // During development start watching files to recompile & run
    // queries on the fly.
    if (process.env.NODE_ENV !== `production`) {
      watch(store.getState().program.directory)
    }
  })
}

const filesToWatch = new Set()
let watcher
const watchComponent = componentPath => {
  // We don't start watching until mid-way through the bootstrap so ignore
  // new components being added until then. This doesn't affect anything as
  // when extractQueries is called from bootstrap, we make sure that all
  // components are being watched.
  if (
    process.env.NODE_ENV !== `production` &&
    !filesToWatch.has(componentPath)
  ) {
    filesToWatch.add(componentPath)
    if (watcher) {
      watcher.add(componentPath)
    }
  }
}

const debounceCompile = _.debounce(() => {
  updateStateAndRunQueries()
}, 100)

const watch = async rootDir => {
  if (watcher) return

  const modulesThatUseGatsby = await getGatsbyDependents()

  const packagePaths = modulesThatUseGatsby.map(module => {
    const filesRegex = `*.+(t|j)s?(x)`
    const pathRegex = `/{${filesRegex},!(node_modules)/**/${filesRegex}}`
    return slash(path.join(module.path, pathRegex))
  })

  watcher = chokidar
    .watch([
      slash(path.join(rootDir, `/src/**/*.{js,jsx,ts,tsx}`)),
      ...packagePaths,
    ])
    .on(`change`, path => {
      report.pendingActivity({ id: `query-extraction` })
      debounceCompile()
    })

  filesToWatch.forEach(filePath => watcher.add(filePath))
}

exports.startWatchDeletePage = () => {
  emitter.on(`DELETE_PAGE`, action => {
    const componentPath = slash(action.payload.component)
    const { pages } = store.getState()
    let otherPageWithTemplateExists = false
    for (let page of pages.values()) {
      if (slash(page.component) === componentPath) {
        otherPageWithTemplateExists = true
        break
      }
    }
    if (!otherPageWithTemplateExists) {
      store.dispatch({
        type: `REMOVE_TEMPLATE_COMPONENT`,
        payload: {
          componentPath,
        },
      })
    }
  })
}
