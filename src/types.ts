export enum ContentType { HTML, LINK }

export interface MdxRecord {
    entry: string;
    paraphrase: string;
    contentType?: ContentType;
    rowid?: number;
}
