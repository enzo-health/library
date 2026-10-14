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

/**
 * the proxy event schema is zod-based; it is loaded with the proxy connection
 * so zod stays out of the production client bundle (module level because the
 * React Compiler cannot lower an import() inside a hook)
 */
const loadLiveProxyEventSchema = () =>
	import("./liveProxyEvents").then((module) => module.liveProxyEventSchema)

/**
 * the visual editing overlay and preview toast pull in @sanity/visual-editing
 * and @sanity/ui, so they only load in draft mode or inside an iframe
 */
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

/**
 * the presentation tool renders the site in an iframe before draft mode is
 * necessarily enabled; that is the one case the preview toast is needed
 * outside draft mode
 */
const useIsEmbedded = () => {
	const [isEmbedded, setIsEmbedded] = useState(false)
	useEffect(() => {
		setIsEmbedded(window.self !== window.top)
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

		void loadLiveProxyEventSchema().then((liveProxyEventSchema) => {
			if (isDisposed) return

			const handleMessage = (e: MessageEvent<string>) => {
				const parsed = liveProxyEventSchema.safeParse(JSON.parse(e.data))
				if (parsed.success) handleEvent(parsed.data)
			}

			const connect = () => {
				if (isDisposed) return

				eventSource?.close()
				eventSource = new EventSource("/api/live")
				eventSource.onmessage = (e) => {
					try {
						handleMessage(e)
					} catch {
						// ignore malformed messages
					}
				}
				eventSource.addEventListener("reconnect", () => {
					eventSource?.close()
					reconnectTimer = setTimeout(connect, liveProxyReconnectDelayMs)
				})
			}

			connect()
		})

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
