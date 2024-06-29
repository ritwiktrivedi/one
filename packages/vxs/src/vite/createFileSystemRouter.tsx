import { BroadcastChannel, Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { Connect, Plugin } from 'vite'
import { DevEnvironment, RemoteEnvironmentTransport, createServerModuleRunner } from 'vite'
import { createHandleRequest } from '../handleRequest'
import { LoaderDataCache } from './constants'
import { replaceLoader } from './replaceLoader'
import { resolveAPIRequest } from './resolveAPIRequest'
import { virtalEntryIdClient, virtualEntryId } from './virtualEntryPlugin'
import { isResponse } from '../utils/isResponse'
import { isStatusRedirect } from '../utils/isStatus'
import type { VXS } from './types'
import { getOptimizeDeps } from 'vxrn'

export function createFileSystemRouter(options: VXS.PluginOptions): Plugin {
  const optimizeDeps = getOptimizeDeps('serve')

  return {
    name: `router-fs`,
    enforce: 'post',
    apply: 'serve',

    // config() {
    //   return {
    //     environments: {
    //       server: {
    //         dev: {
    //           moduleRunnerTransform: true,
    //           preTransformRequests: true,
    //           optimizeDeps,
    //           createEnvironment(name, config) {
    //             const worker = new Worker(join(import.meta.dirname, 'server.js'))
    //             // const hot = new
    //             return new DevEnvironment(name, config, {
    //               hot: false,
    //               runner: {
    //                 transport: new RemoteEnvironmentTransport({
    //                   send: (data) => worker.postMessage(data),
    //                   onMessage: (listener) => worker.on('message', listener),
    //                 }),
    //               },
    //             })
    //           },
    //         },
    //       },
    //     },
    //   }
    // },

    configureServer(server) {
      const runner = createServerModuleRunner(server.environments.ssr)

      // handle only one at a time in dev mode to avoid "Detected multiple renderers concurrently" errors
      let renderPromise: Promise<void> | null = null

      const handleRequest = createHandleRequest(options, {
        async handleSSR({ route, url, loaderProps }) {
          console.info(` [vxs] «« ${url} resolved to ${route.file}`)

          if (renderPromise) {
            await renderPromise
          }

          const { promise, resolve } = Promise.withResolvers<void>()
          renderPromise = promise

          try {
            const routeFile = join('app', route.file)
            // importing directly causes issues :/
            globalThis['__vxrnresetState']?.()
            runner.clearCache()

            const exported = await runner.import(routeFile)

            const loaderData = await exported.loader?.(loaderProps)

            // TODO move to tamagui plugin, also esbuild was getting mad
            // biome-ignore lint/security/noGlobalEval: <explanation>
            eval(`process.env.TAMAGUI_IS_SERVER = '1'`)

            const entry = await runner.import(virtualEntryId)

            globalThis['__vxrnLoaderData__'] = loaderData
            globalThis['__vxrnLoaderProps__'] = loaderProps
            LoaderDataCache[route.file] = loaderData

            const html = await entry.default.render({
              loaderData,
              loaderProps,
              path: loaderProps?.path,
              preloads: ['/@vite/client', virtalEntryIdClient],
            })
            return html
          } catch (err) {
            const title = `Error rendering ${url.pathname} on server`
            const message = err instanceof Error ? err.message : `${err}`
            const stack = err instanceof Error ? err.stack : ''

            console.error(`${title}\n ${message}\n\n${stack}\n`)

            return `
              <html>
                <body style="background: #000; color: #fff; padding: 5%; font-family: monospace; line-height: 2rem;">
                  <h1>${title}</h1>
                  <h2>${message}</h2>
                  ${
                    stack
                      ? `<pre style="font-size: 15px; line-height: 24px; white-space: pre;">
                      ${stack}
                  </pre>`
                      : ``
                  }
                </body>
              </html>
            `
          } finally {
            resolve()
          }
        },

        async handleLoader({ request, route, loaderProps }) {
          const routeFile = join('app', route.file)

          // this will remove all loaders
          let transformedJS = (await server.transformRequest(routeFile))?.code
          if (!transformedJS) {
            throw new Error(`No transformed js returned`)
          }
          const exported = await runner.import(routeFile)
          const loaderData = await exported.loader?.(loaderProps)

          if (loaderData) {
            // add loader back in!
            transformedJS = replaceLoader({
              code: transformedJS,
              loaderData,
              loaderProps,
            })
          }

          return transformedJS
        },

        async handleAPI({ request, route }) {
          return resolveAPIRequest(() => runner.import(join('app', route.file)), request)
        },
      })

      // Instead of adding the middleware here, we return a function that Vite
      // will call after adding its own middlewares. We want our code to run after
      // Vite's transform middleware so that we can focus on handling the requests
      // we're interested in.
      return () => {
        server.middlewares.use(async (req, res, next) => {
          try {
            if (options.redirects) {
              const url = new URL(req.url || '', `http://${req.headers.host}`)
              for (const redirect of options.redirects) {
                const regexStr = `^${redirect.source.replace(/:\w+/g, '([^/]+)')}$`
                const match = url.pathname.match(new RegExp(regexStr))

                if (match) {
                  let destination = redirect.destination
                  const params = redirect.source.match(/:\w+/g)

                  if (params) {
                    params.forEach((param, index) => {
                      destination = destination.replace(param, match[index + 1] || '')
                    })
                  }

                  console.warn(` [vxs] redirecting via redirect: ${destination}`)

                  res.writeHead(redirect.permanent ? 301 : 302, { Location: destination })
                  res.end()
                  return
                }
              }
            }

            const reply = await handleRequest(await convertIncomingMessageToRequest(req))

            if (!reply) {
              return next()
            }

            if (typeof reply !== 'string' && isResponse(reply)) {
              if (isStatusRedirect(reply.status)) {
                const location = `${reply.headers.get('location') || ''}`
                console.info(` ↦ Redirect ${location}`)
                if (location) {
                  res.writeHead(reply.status, {
                    Location: location,
                  })
                  res.end()
                  return
                }
                console.error(`No location provided to redirected status reply`, reply)
              }

              res.statusCode = reply.status
              res.statusMessage = reply.statusText

              reply.headers.forEach((value, key) => {
                if (key === 'set-cookie') {
                  // for some reason it wasnt doing working without this?
                  const cookies = value.split(', ')
                  for (const cookie of cookies) {
                    res.appendHeader('Set-Cookie', cookie)
                  }
                } else {
                  res.setHeader(key, value)
                }
              })

              const contentType = reply.headers.get('Content-Type')
              const outString =
                contentType === 'application/json'
                  ? JSON.stringify(await reply.json())
                  : await reply.text()

              res.write(outString)
              res.end()
              return
            }

            if (reply && typeof reply === 'object') {
              res.setHeader('Content-Type', 'application/json')
              res.write(JSON.stringify(reply))
              res.end()
              return
            }

            res.write(reply)
            res.end()
            return
          } catch (error) {
            // Forward the error to Vite
            next(error)
          }

          // We're not calling `next` because our handler will always be
          // the last one in the chain. If it didn't send a response, we
          // will treat it as an error since there will be no one else to
          // handle it in production.
          console.warn(`SSR handler didn't send a response for url: ${req.url}`)
        })
      }
    },
  } satisfies Plugin
}

const convertIncomingMessageToRequest = async (req: Connect.IncomingMessage): Promise<Request> => {
  if (!req.originalUrl) {
    throw new Error(`Can't convert`)
  }

  const urlBase = `http://${req.headers.host}`
  const urlString = req.originalUrl || ''
  const url = new URL(urlString, urlBase)

  const headers = new Headers()
  for (const key in req.headers) {
    if (req.headers[key]) headers.append(key, req.headers[key] as string)
  }

  return new Request(url, {
    method: req.method,
    body: req.method === 'POST' ? await readStream(req) : null,
    headers,
  })
}

function readStream(stream: Connect.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    stream.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}
