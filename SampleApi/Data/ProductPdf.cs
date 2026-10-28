using System.Globalization;
using System.Text;
using SampleApi.Models;

namespace SampleApi.Data;

public static class ProductPdf
{
    private const int RowsPerPage = 36;

    public static byte[] Generate(IReadOnlyList<Product> products)
    {
        var pageCount = Math.Max(1, (products.Count + RowsPerPage - 1) / RowsPerPage);
        var objects = new List<byte[]>
        {
            Ascii("<< /Type /Catalog /Pages 2 0 R >>"),
            Array.Empty<byte>(),
            Ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
        };
        var pageReferences = new List<int>();

        for (var pageIndex = 0; pageIndex < pageCount; pageIndex++)
        {
            var pageObjectId = objects.Count + 1;
            var contentObjectId = pageObjectId + 1;
            pageReferences.Add(pageObjectId);

            var firstRow = pageIndex * RowsPerPage;
            var rowsOnPage = Math.Min(RowsPerPage, products.Count - firstRow);
            var content = BuildPage(products, firstRow, rowsOnPage, pageIndex + 1, pageCount);

            objects.Add(Ascii(
                $"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
                $"/Resources << /Font << /F1 3 0 R >> >> /Contents {contentObjectId} 0 R >>"));
            objects.Add(BuildStream(content));
        }

        objects[1] = Ascii(
            $"<< /Type /Pages /Kids [{string.Join(" ", pageReferences.Select(id => $"{id} 0 R"))}] " +
            $"/Count {pageReferences.Count} >>");

        using var output = new MemoryStream();
        Write(output, "%PDF-1.4\n");
        var offsets = new List<long> { 0 };

        for (var index = 0; index < objects.Count; index++)
        {
            offsets.Add(output.Position);
            Write(output, $"{index + 1} 0 obj\n");
            output.Write(objects[index]);
            Write(output, "\nendobj\n");
        }

        var xrefOffset = output.Position;
        Write(output, $"xref\n0 {objects.Count + 1}\n");
        Write(output, "0000000000 65535 f \n");
        foreach (var offset in offsets.Skip(1))
        {
            Write(output, $"{offset:0000000000} 00000 n \n");
        }

        Write(output,
            $"trailer\n<< /Size {objects.Count + 1} /Root 1 0 R >>\n" +
            $"startxref\n{xrefOffset}\n%%EOF\n");
        return output.ToArray();
    }

    private static byte[] BuildPage(
        IReadOnlyList<Product> products,
        int firstRow,
        int rowsOnPage,
        int pageNumber,
        int pageCount)
    {
        var content = new StringBuilder();
        AddText(content, 50, 750, 20, "Product catalog");
        AddText(content, 50, 728, 9,
            $"Generated {DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm 'UTC'", CultureInfo.InvariantCulture)}");
        AddRule(content, 50, 710, 562);
        AddText(content, 50, 692, 10, "Product");
        AddText(content, 265, 692, 10, "Category");
        AddText(content, 435, 692, 10, "Unit price");
        AddText(content, 520, 692, 10, "Stock");
        AddRule(content, 50, 680, 562);

        for (var row = 0; row < rowsOnPage; row++)
        {
            var product = products[firstRow + row];
            var y = 662 - row * 16;
            AddText(content, 50, y, 9, Truncate(product.Name, 34));
            AddText(content, 265, y, 9, Truncate(product.Category, 25));
            AddText(content, 435, y, 9, product.Price.ToString("0.00", CultureInfo.InvariantCulture));
            AddText(content, 520, y, 9, product.Stock.ToString(CultureInfo.InvariantCulture));
            AddRule(content, 50, y - 5, 562);
        }

        AddText(content, 50, 42, 9, $"Page {pageNumber} of {pageCount}");
        return Ascii(content.ToString());
    }

    private static void AddText(StringBuilder content, int x, int y, int size, string value)
    {
        content.Append("BT /F1 ")
            .Append(size)
            .Append(" Tf ")
            .Append(x)
            .Append(' ')
            .Append(y)
            .Append(" Td (")
            .Append(Escape(value))
            .Append(") Tj ET\n");
    }

    private static void AddRule(StringBuilder content, int x, int y, int width) =>
        content.Append(x).Append(' ').Append(y).Append(" m ")
            .Append(x + width).Append(' ').Append(y).Append(" l S\n");

    private static string Truncate(string value, int maxLength)
    {
        var printable = new string(value.Select(character =>
            char.IsAscii(character) && character is not '\r' and not '\n' ? character : '?').ToArray());
        return printable.Length <= maxLength
            ? printable
            : string.Concat(printable.AsSpan(0, maxLength - 3), "...");
    }

    private static string Escape(string value) =>
        value.Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("(", "\\(", StringComparison.Ordinal)
            .Replace(")", "\\)", StringComparison.Ordinal);

    private static byte[] BuildStream(byte[] content)
    {
        using var stream = new MemoryStream();
        Write(stream, $"<< /Length {content.Length} >>\nstream\n");
        stream.Write(content);
        Write(stream, "\nendstream");
        return stream.ToArray();
    }

    private static byte[] Ascii(string value) => Encoding.ASCII.GetBytes(value);

    private static void Write(Stream stream, string value) =>
        stream.Write(Ascii(value));
}
