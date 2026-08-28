export function assertNoXmlDoctype(content: string): void {
  if (/<!DOCTYPE\b/i.test(content)) {
    throw new Error('SOAP_XML_DOCTYPE_FORBIDDEN: WSDL and XSD documents must not declare a DTD');
  }
}
