package dev.keiji.photomasaic.io

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Date
import java.util.TimeZone

/** 保存ファイル名の書式テスト(A1)。 */
class ExportNamingTest {
    @Test
    fun fileNameUsesUtcTimestamp() {
        assertEquals(
            "photomosaic_19700101_000000.png",
            buildFileName(Date(0L), TimeZone.getTimeZone("UTC")),
        )
    }

    @Test
    fun fileNameUsesProvidedTimeZone() {
        assertEquals(
            "photomosaic_19700101_090000.png",
            buildFileName(Date(0L), TimeZone.getTimeZone("Asia/Tokyo")),
        )
    }
}
