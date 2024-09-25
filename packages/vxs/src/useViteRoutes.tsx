import { CACHE_KEY, CLIENT_BASE_URL } from './router/constants'
import type { GlobbedRouteImports } from './types'
import { dynamicImport } from './utils/dynamicImport'
import { removeSearch } from './utils/removeSearch'
import type { VXS } from './vite/types'

// essentially a development helper

let lastVersion = 0
let context

// for some reason putting it in state doesnt even re-render
export function useViteRoutes(
  routes: GlobbedRouteImports,
  options?: VXS.RouteOptions,
  version?: number
) {
  if (version && version > lastVersion) {
    // reload
    context = null
    lastVersion = version
  }

  if (!context) {
    loadRoutes(routes, options)
  }

  return context
}

export function loadRoutes(paths: GlobbedRouteImports, options?: VXS.RouteOptions) {
  if (context) return context
  globalThis['__importMetaGlobbed'] = paths
  context = globbedRoutesToRouteContext(paths, options)
  return context
}

export function globbedRoutesToRouteContext(
  paths: GlobbedRouteImports,
  options?: VXS.RouteOptions
): VXS.RouteContext {
  // make it look like webpack context
  const routesSync = {}
  const promises = {}
  const loadedRoutes = {}
  const clears = {}

  Object.keys(paths).map((path) => {
    if (!paths[path]) {
      console.error(`Error: Missing route at path ${path}`)
      return
    }
    const loadRouteFunction = paths[path]
    const pathWithoutRelative = path.replace('/app/', './')
    const shouldRewrite = typeof window !== 'undefined' && window.location && !import.meta.env.PROD

    const originalPath = pathWithoutRelative.slice(1).replace(/\.[jt]sx?$/, '')
    if (options?.routeModes?.[originalPath] === 'spa') {
      console.info(`Spa mode: ${originalPath}`)
      // in SPA mode return null for any route
      loadedRoutes[pathWithoutRelative] = () => {
        return null
      }
    }
    // TODO this entire conditional seems like it can go away
    else if (shouldRewrite) {
      // for SSR support we rewrite these:
      routesSync[pathWithoutRelative] =
        path.includes('_layout.') || path.includes('+spa')
          ? loadRouteFunction
          : () => {
              const realPath = (globalThis['__vxrntodopath'] ?? window.location.pathname).trim()
              const importUrl = `${CLIENT_BASE_URL}/assets${removeSearch(
                realPath
              )}_vxrn_loader.js?cache_key=${CACHE_KEY}`
              return dynamicImport(importUrl)
            }
    } else {
      routesSync[pathWithoutRelative] = loadRouteFunction
    }
  })

  const moduleKeys = Object.keys(routesSync)

  function resolve(id: string) {
    clearTimeout(clears[id])
    if (loadedRoutes[id]) {
      return loadedRoutes[id]
    }
    if (typeof routesSync[id] !== 'function') {
      return routesSync[id]
    }
    if (!promises[id]) {
      promises[id] = routesSync[id]()
        .then((val: any) => {
          loadedRoutes[id] = val
          delete promises[id]

          // clear cache so we get fresh contents in dev mode (hacky)
          clears[id] = setTimeout(() => {
            delete loadedRoutes[id]
          }, 500)

          return val
        })
        .catch((err) => {
          console.error(`Error loading route`, id, err, new Error().stack)
          loadedRoutes[id] = {
            default: () => null,
            // <View
            //   style={{
            //     position: 'absolute',
            //     top: 0,
            //     left: 0,
            //     right: 0,
            //     bottom: 0,
            //     alignItems: 'center',
            //     justifyContent: 'center',
            //     backgroundColor: '#000',
            //     gap: 20,
            //   }}
            // >
            //   <Text style={{ fontSize: 24, color: '#fff' }}>Error loading route</Text>
            //   <Text style={{ fontSize: 16, color: '#fff' }}>{id}</Text>
            //   <Text style={{ fontSize: 18, color: '#fff', maxWidth: 800 }}>{`${err}`}</Text>
            // </View>
          }
          delete promises[id]
        })

      if (process.env.NODE_ENV === 'development') {
        promises[id].stack = new Error().stack
      }
    }

    // this is called in useScreens value.loadRoute
    // see getRoutes.ts contextModule.loadRoute
    // where contextModule === this resolve function
    throw promises[id]
  }

  resolve.keys = () => moduleKeys
  resolve.id = ''
  resolve.resolve = (id: string) => id

  return resolve
}
