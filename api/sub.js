// File: /api/sub.js

import { promises as fs } from 'fs';
import path from 'path';

/**
 * Handles subscription requests by serving the content of a specified file.
 */
export default async function handler(req, res) {
    // Set CORS headers to allow access from any origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Set Cache-Control to ensure clients always get the latest version
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    // Subscription links should only be accessible via GET
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).json({ message: `Method ${req.method} Not Allowed` });
    }

    try {
        // Construct the full path to the source file located in the project's root
        const filePath = path.resolve(process.cwd(), 'all_live_configs.json');
        
        // Asynchronously read the file's content
        const fileContent = await fs.readFile(filePath, 'utf8');

        // Set the correct Content-Type header so clients recognize it as a subscription
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        
        // Send the file content with a 200 OK status
        res.status(200).send(fileContent);

    } catch (error) {
        // Log the error for debugging purposes on the server side
        console.error('Error reading or serving subscription file:', error);
        
        // If the file doesn't exist, return a 404 Not Found
        if (error.code === 'ENOENT') {
            return res.status(404).json({ message: 'Subscription source file not found.' });
        }
        
        // For any other errors, return a 500 Internal Server Error
        return res.status(500).json({ message: 'Internal Server Error while processing subscription.' });
    }
}
