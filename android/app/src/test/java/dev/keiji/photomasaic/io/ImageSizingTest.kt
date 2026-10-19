@file:Suppress("MagicNumber")

package dev.keiji.photomasaic.io

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** 正規化・サムネイル寸法・ボックスフィルタの純関数テスト(A1)。 */
class ImageSizingTest {
    @Test
    fun normalizeKeepsImageWithinLimit() {
        assertEquals(NormalizedSize(4096, 100, scaled = false), normalizeSize(4096, 100))
        assertEquals(NormalizedSize(100, 50, scaled = false), normalizeSize(100, 50))
    }

    @Test
    fun normalizeScalesLongEdgeTo4096() {
        assertEquals(NormalizedSize(4096, 3072, scaled = true), normalizeSize(8000, 6000))
        assertEquals(NormalizedSize(4096, 82, scaled = true), normalizeSize(5000, 100))
    }

    @Test
    fun normalizeRejectsNonPositiveSize() {
        assertThrows(IllegalArgumentException::class.java) { normalizeSize(0, 10) }
        assertThrows(IllegalArgumentException::class.java) { normalizeSize(10, -1) }
    }

    @Test
    fun composeThumbScalesTo64() {
        assertEquals(NormalizedSize(64, 32, scaled = true), composeThumbSize(128, 64))
        assertEquals(NormalizedSize(64, 64, scaled = true), composeThumbSize(512, 512))
        assertEquals(NormalizedSize(40, 20, scaled = false), composeThumbSize(40, 20))
    }

    @Test
    fun boxResizeAveragesFourPixels() {
        val source =
            intArrayOf(
                0xFFFF0000.toInt(),
                0xFF00FF00.toInt(),
                0xFF0000FF.toInt(),
                0xFFFFFFFF.toInt(),
            )
        val result = boxResize(source, 2, 2, 1, 1)
        assertEquals(0xFF808080.toInt(), result[0])
    }

    @Test
    fun boxResizeAtSameSizeKeepsPixels() {
        val source =
            intArrayOf(
                0xFFFF0000.toInt(),
                0xFF00FF00.toInt(),
                0xFF0000FF.toInt(),
                0xFFFFFFFF.toInt(),
            )
        assertArrayEquals(source, boxResize(source, 2, 2, 2, 2))
    }
}
