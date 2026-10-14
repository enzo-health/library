"use client"

import { useInterval } from "ahooks"
import { browserData } from "library/deviceDetection"
import { useHMR } from "library/useHMR"
import { useRouter } from "next/navigation"
import { stegaClean } from "next-sanity"
import { useVisualEditingEnvironment } from "next-sanity/hooks"
import { VisualEditing } from "next-sanity/visual-editing"
import { useEffect, useTransition } from "react"
import { toast } from "sonner"
import { disableDraftMode } from "./disableDraftMode"

/**
 * draft mode UI: the visual editing overlay and the preview status toast
 *
 * loaded lazily by `RuntimeClient`, only in draft mode or inside an iframe
 * (the presentation tool), because `next-sanity/hooks` and
 * `next-sanity/visual-editing` bring all of @sanity/visual-editing and
 * @sanity/ui with them
 */
export default function DraftModeTools({
	isDraftMode,
}: {
	isDraftMode: boolean
}) {
	const environment = useVisualEditingEnvironment()
	const isPresentation =
		environment === "presentation-iframe" ||
		environment === "presentation-window"

	return (
		<>
			<SanityPreviewStatusToast
				isDraftMode={isDraftMode}
				isPresentation={isPresentation}
			/>
			{isDraftMode && <VisualEditing />}
			{isDraftMode && <FirefoxFix />}
		</>
	)
}

function SanityPreviewStatusToast({
	isDraftMode,
	isPresentation,
}: {
	isDraftMode: boolean
	isPresentation: boolean
}) {
	const router = useRouter()
	const [pending, startTransition] = useTransition()

	useEffect(() => {
		if (!isPresentation && !isDraftMode) return

		const toastId = toast(
			isDraftMode ? "Viewing Drafted Content" : "Viewing Published Content",
			{
				duration: !isDraftMode && isPresentation ? Infinity : undefined,
				action:
					isDraftMode && !isPresentation
						? {
								label: "Disable",
								onClick: async () => {
									await disableDraftMode()
									startTransition(() => {
										router.refresh()
									})
								},
							}
						: undefined,
			},
		)

		return () => {
			toast.dismiss(toastId)
		}
	}, [isDraftMode, isPresentation, router])

	useEffect(() => {
		if (pending) {
			const toastId = toast.loading("Disabling draft mode...")
			return () => {
				toast.dismiss(toastId)
			}
		}
	}, [pending])

	return null
}

let hasWarned = false

const zeroWidthChars = /\u200B|\u200C|\u200D|\uFEFF/g

const checkZeroWidthChars = (startNode: Node = document.body) => {
	const walk = (node: Node) => {
		if (window.lenisInstance?.isScrolling) return

		if (node.nodeType === Node.TEXT_NODE) {
			const parent = node.parentElement
			const hasStega = zeroWidthChars.test(node.textContent ?? "")

			if (parent && hasStega) {
				const computedStyle = getComputedStyle(parent)
				const letterSpacing = parseFloat(computedStyle.letterSpacing)

				if (letterSpacing !== 0) {
					const cleanContent = stegaClean(node.textContent ?? "")
					node.textContent = cleanContent

					if (!hasWarned) {
						hasWarned = true
						toast.info("Some draft mode features are disabled in Firefox")
					}
				}
			}
		} else {
			node.childNodes.forEach(walk)
		}
	}

	walk(startNode)
}

function FirefoxFix() {
	useInterval(() => {
		if (browserData.isFireFox) checkZeroWidthChars()
	}, 1000)
	useHMR("afterRefresh", () => {
		if (browserData.isFireFox) {
			checkZeroWidthChars()
		}
	})

	return null
}
