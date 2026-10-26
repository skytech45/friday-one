package com.friday.one.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Capability payload parsing (plan §9). The control plane returns agents and
 * projects per server; the app must render them without crashing on older
 * servers (fields absent) or partial rows (empty ids).
 */
class ServerParsingTest {
    private val client = ControlPlaneClient()
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun parsesAgentsProjectsAndOnlineFlag() {
        val obj = json.parseToJsonElement(
            """
            {
              "id": "s1", "name": "vps", "enrollment_state": "active", "online": true,
              "agents": [
                {"id": "a1", "adapter": "hermes", "version": "0.22.5", "health": "healthy"},
                {"id": "a2", "adapter": "opencode", "version": null, "health": "unknown"}
              ],
              "projects": [
                {"id": "p1", "root": "/srv/app", "label": "app"}
              ]
            }
            """.trimIndent(),
        ).jsonObject

        val server = client.parseServer(obj)
        assertEquals("s1", server.id)
        assertEquals("vps", server.name)
        assertTrue(server.online)
        assertEquals(listOf("hermes", "opencode"), server.agents.map { it.adapter })
        assertEquals("0.22.5", server.agents[0].version)
        assertNull(server.agents[1].version)
        assertEquals("/srv/app", server.projects.single().root)
        assertEquals("app", server.projects.single().label)
    }

    @Test
    fun toleratesServersFromBeforeCapabilityDiscovery() {
        val obj = json.parseToJsonElement(
            """{"id":"s1","name":"old","enrollment_state":"active","online":false}""",
        ).jsonObject

        val server = client.parseServer(obj)
        assertTrue(server.agents.isEmpty())
        assertTrue(server.projects.isEmpty())
        assertEquals("active", server.enrollmentState)
    }

    @Test
    fun dropsPartialCapabilityRows() {
        val obj = json.parseToJsonElement(
            """
            {"id":"s1","name":"x","enrollment_state":"active","online":true,
             "agents":[{"id":"","adapter":"hermes"},{"id":"a2","adapter":""},
                       {"id":"a3","adapter":"hermes","version":"1.0","health":"healthy"}],
             "projects":[{"id":"p1","root":""},{"id":"p2","root":"/srv/x","label":null}]}
            """.trimIndent(),
        ).jsonObject

        val server = client.parseServer(obj)
        assertEquals(listOf("a3"), server.agents.map { it.id })
        assertEquals(listOf("p2"), server.projects.map { it.id })
        assertNull(server.projects.single().label)
    }
}
