import { Effect, Exit, Scope } from "effect"
import { Callable, CefTexture } from "godot"
import { Events, Procedures, RpcServer } from "@codename-painless/common"

// In development, point at the Vite dev server (`bun run --cwd packages/ui dev`)
// for hot reload. For a shipped build, point this at the built UI instead,
// e.g. `file://${ProjectSettings.globalize_path("res://ui/index.html")}`
// after copying packages/ui/dist into the exported project.
const DEV_SERVER_URL = "http://codename-painless-ui.localhost"

export default class WebView extends CefTexture {
    static instance: WebView

    private scope!: Scope.Closeable
    private server!: RpcServer.Server<typeof Events.Event>

    constructor() {
        super()
        WebView.instance = this
    }

    _ready(): void {
        this.enable_accelerated_osr = true
        this.url = DEV_SERVER_URL

        this.connect(
            "load_finished",
            Callable.create(() => {
                console.log(`[WebView] loaded ${this.url}`)
            }),
        )

        // godot-cef only gives a single `ipc_message` signal (UI -> game); wrap
        // it as the pub/sub `onMessage` that Rpc.ts's transport contract expects.
        const messageListeners = new Set<(message: string) => void>()
        this.connect(
            "ipc_message",
            Callable.create((message: string) => {
                for (const listener of messageListeners) listener(message)
            }),
        )

        this.scope = Effect.runSync(Scope.make())
        this.server = Effect.runSync(
            Scope.provide(this.scope)(
                RpcServer.make({
                    transport: {
                        send: (message) => {
                            // Game -> UI has no channel but `eval`: run JS in the page that
                            // hands the message to the receiver the UI's ipc bridge installs
                            // (packages/ui/src/lib/ipc.ts).
                            const json = JSON.stringify(message)
                            this.eval(
                                `window.__codenamePainless && window.__codenamePainless.receive(${json})`,
                            )
                        },
                        onMessage: (listener) => {
                            messageListeners.add(listener)
                            return () => messageListeners.delete(listener)
                        },
                    },
                    request: Procedures.Request,
                    success: Procedures.success,
                    error: Procedures.error,
                    event: Events.Event,
                    // No procedures defined yet — see packages/common/src/Procedures.ts.
                    handlers: {},
                }),
            ),
        )
    }

    _exit_tree(): void {
        Effect.runFork(Scope.close(this.scope, Exit.succeed(undefined)))
    }

    emit(event: typeof Events.Event.Type): Effect.Effect<void> {
        return this.server.emit(event)
    }
}
