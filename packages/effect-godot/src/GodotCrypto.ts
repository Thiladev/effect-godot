import { Crypto, Effect, Layer } from "effect"
import { Crypto as GodotCrypto } from "godot"


const godotCrypto = new GodotCrypto()

export const crypto: Crypto.Crypto = Crypto.make({
    randomBytes: size => new Uint8Array(godotCrypto.generate_random_bytes(size).to_array_buffer()),
    digest: () => Effect.die(new Error("GodotCrypto: digest is not implemented")),
})

export const layer: Layer.Layer<Crypto.Crypto> = Layer.succeed(Crypto.Crypto, crypto)
