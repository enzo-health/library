"use client"

import { getDeploymentVersionMetadata } from "library/deploymentVersion"
import TypedEventEmitter from "library/TypedEventEmitter"
import dynamic from "next/dynamic"
import { usePathname, useRouter } from "next/navigation"
import type { ReactNode } from "react"
import { useEffect, useState, useTransition } from "react"
import { studioUrl } from "sanity/lib/api"
import { Toaster, toast } from "sonner"
import type { LiveProxyEvent } from "./liveProxyEvents"

const sanityLiveRefreshEvents = new TypedEventEmitter<{ refresh: [] }>()
const liveProxyReconnectDelayMs = 250

// loaded with the proxy connection so zod stays out of the production bundle
// (module level: the React Compiler can't lower import() inside a hook)
const loadLiveProxyEventSchema = () =>
	import("./liveProxyEvents").then((module) => module.liveProxyEventSchema)

// pulls in @sanity/visual-editing and @sanity/ui; only loaded in draft mode or the presentation tool
const DraftModeTools = dynamic(() => import("./live.draft"), { ssr: false })

export async function notifySanityLiveRefreshAction() {
	sanityLiveRefreshEvents.dispatchEvent("refresh")
	return "refresh" as const
}

function notifyDeploymentUpdate({
	liveDeployment,
}: {
	liveDeployment?: ReturnType<typeof getDeploymentVersionMetadata>
}) {
	const { deploymentId } = getDeploymentVersionMetadata()

	if (deploymentId === liveDeployment?.deploymentId) return
	if (!window.location.pathname.startsWith(studioUrl)) return

	toast.warning("New version available", {
		id: "deployment-update-available",
		description: "Drafted content is saved by Sanity",
		duration: Infinity,
		action: {
			label: "Update",
			onClick: () => window.location.reload(),
		},
	})
}

// the presentation tool shows the site in an iframe or popup before draft mode is enabled
const useIsEmbedded = () => {
	const [isEmbedded, setIsEmbedded] = useState(false)
	useEffect(() => {
		setIsEmbedded(window.self !== window.top || window.opener !== null)
	}, [])
	return isEmbedded
}

export function RuntimeClient({
	children,
	isDraftMode,
	useLiveProxy,
}: {
	children?: ReactNode
	isDraftMode: boolean
	useLiveProxy: boolean
}) {
	const pathname = usePathname()
	const isStudio = pathname.startsWith(studioUrl)
	const isEmbedded = useIsEmbedded()

	if (isStudio) {
		return (
			<>
				<Toaster />
				<SanityRuntimeRefresh
					showRefreshToast={false}
					useLiveProxy={useLiveProxy}
				/>
			</>
		)
	}

	return (
		<>
			<Toaster />
			{(useLiveProxy || isDraftMode) && (
				<SanityRuntimeRefresh
					showRefreshToast={isDraftMode}
					useLiveProxy={useLiveProxy}
				/>
			)}
			{children}
			{(isDraftMode || isEmbedded) && (
				<DraftModeTools isDraftMode={isDraftMode} />
			)}
		</>
	)
}

export function SanityRuntimeRefresh({
	showRefreshToast,
	useLiveProxy,
}: {
	showRefreshToast: boolean
	useLiveProxy: boolean
}) {
	const router = useRouter()
	const [pending, startTransition] = useTransition()
	const [, setSanityLiveRefreshSignal] = useState(0)

	useEffect(() => {
		if (!useLiveProxy) return

		let eventSource: EventSource | undefined
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined
		let isDisposed = false

		const handleEvent = (event: LiveProxyEvent) => {
			if (event.type === "connected") {
				notifyDeploymentUpdate({ liveDeployment: event.deployment })
				return
			} else if (event.type === "refresh") {
				if (window.location.pathname.startsWith(studioUrl)) return

				startTransition(() => {
					router.refresh()
				})

				return
			}

			event satisfies never
		}

		const start = () => {
			void loadLiveProxyEventSchema().then(
				(liveProxyEventSchema) => {
					if (isDisposed) return

					const parseLiveProxyEvent = (data: string): LiveProxyEvent | null => {
						let json: unknown
						try {
							json = JSON.parse(data)
						} catch {
							return null
						}
						const parsed = liveProxyEventSchema.safeParse(json)
						return parsed.success ? parsed.data : null
					}

					const connect = () => {
						if (isDisposed) return

						eventSource?.close()
						eventSource = new EventSource("/api/live")
						eventSource.onmessage = (e: MessageEvent<string>) => {
							const event = parseLiveProxyEvent(e.data)
							if (event) handleEvent(event)
						}
						eventSource.addEventListener("reconnect", () => {
							eventSource?.close()
							reconnectTimer = setTimeout(connect, liveProxyReconnectDelayMs)
						})
					}

					connect()
				},
				() => {
					// chunk failed to load; retry like a dropped connection
					if (!isDisposed)
						reconnectTimer = setTimeout(start, liveProxyReconnectDelayMs)
				},
			)
		}

		start()

		return () => {
			isDisposed = true
			if (reconnectTimer) clearTimeout(reconnectTimer)
			eventSource?.close()
		}
	}, [router, useLiveProxy])

	useEffect(() => {
		const handleSanityLiveRefresh = () => {
			startTransition(() => {
				setSanityLiveRefreshSignal((signal) => signal + 1)
			})
		}

		sanityLiveRefreshEvents.addEventListener("refresh", handleSanityLiveRefresh)
		return () => {
			sanityLiveRefreshEvents.removeEventListener(
				"refresh",
				handleSanityLiveRefresh,
			)
		}
	}, [])

	useEffect(() => {
		if (!pending || !showRefreshToast) return

		const toastId = toast.loading("Refreshing content...")
		return () => {
			toast.dismiss(toastId)
		}
	}, [pending, showRefreshToast])

	return null
}
