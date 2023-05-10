<template>
	<h1 v-text="cool"></h1>
</template>

<script setup>
	import { ref } from 'vue'

	const cool = ref("awesome")
</script>