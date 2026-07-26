import { createWriteStream } from "node:fs";
import { ZipFile } from "yazl";
import type { DocumentArtifactInput } from "../shared/product.ts";

interface DocumentParagraph {
	style?: "Heading1" | "Heading2" | "Title";
	text: string;
}

function escapeXml(value: string): string {
	return value
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function paragraphs(input: DocumentArtifactInput): DocumentParagraph[] {
	const output: DocumentParagraph[] = [{ style: "Title", text: input.title.trim() }];
	for (const line of input.content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
		const value = line.trimEnd();
		if (value.startsWith("## ")) {
			output.push({ style: "Heading2", text: value.slice(3).trim() });
		} else if (value.startsWith("# ")) {
			output.push({ style: "Heading1", text: value.slice(2).trim() });
		} else if (/^\s*[-*]\s+/.test(value)) {
			output.push({ text: `• ${value.replace(/^\s*[-*]\s+/, "")}` });
		} else {
			output.push({ text: value });
		}
	}
	return output;
}

function paragraphXml(paragraph: DocumentParagraph): string {
	if (!paragraph.text) return "<w:p/>";
	const properties = paragraph.style ? `<w:pPr><w:pStyle w:val="${paragraph.style}"/></w:pPr>` : "";
	return `<w:p>${properties}<w:r><w:t xml:space="preserve">${escapeXml(paragraph.text)}</w:t></w:r></w:p>`;
}

function documentXml(input: DocumentArtifactInput): string {
	const body = paragraphs(input).map(paragraphXml).join("");
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
	<w:body>
		${body}
		<w:sectPr>
			<w:pgSz w:w="11906" w:h="16838"/>
			<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
		</w:sectPr>
	</w:body>
</w:document>`;
}

function stylesXml(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
	<w:docDefaults>
		<w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
		<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>
	</w:docDefaults>
	<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
	<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="300"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
	<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
	<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
</w:styles>`;
}

export async function writeDocx(path: string, input: DocumentArtifactInput): Promise<void> {
	const zip = new ZipFile();
	const timestamp = new Date().toISOString();
	const files: Array<[string, string]> = [
		[
			"[Content_Types].xml",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
	<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
	<Default Extension="xml" ContentType="application/xml"/>
	<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
	<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
	<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
	<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
		],
		[
			"_rels/.rels",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
	<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
	<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
	<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
		],
		[
			"word/_rels/document.xml.rels",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
	<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
		],
		["word/document.xml", documentXml(input)],
		["word/styles.xml", stylesXml()],
		[
			"docProps/core.xml",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
	<dc:title>${escapeXml(input.title)}</dc:title>
	<dc:creator>AgentW</dc:creator>
	<cp:lastModifiedBy>AgentW</cp:lastModifiedBy>
	<dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created>
	<dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified>
</cp:coreProperties>`,
		],
		[
			"docProps/app.xml",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
	<Application>AgentW</Application>
</Properties>`,
		],
	];
	for (const [name, content] of files) zip.addBuffer(Buffer.from(content, "utf8"), name);

	await new Promise<void>((resolveWrite, rejectWrite) => {
		const output = createWriteStream(path, { flags: "wx" });
		output.once("close", resolveWrite);
		output.once("error", rejectWrite);
		zip.outputStream.once("error", rejectWrite);
		zip.outputStream.pipe(output);
		zip.end();
	});
}
