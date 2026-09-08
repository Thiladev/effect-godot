import mitt from "mitt"

type Events = {
    ready: string
}

export const events = mitt<Events>()
