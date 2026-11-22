<script lang="ts">
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "../app.css";
import favicon from "#lib/assets/favicon.svg";
import type { LayoutProps } from "./$types";

let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>화질구지 개선기</title>
</svelte:head>

{@render children()}
