 
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.post('/submit-preferences', async (req, res) => {
    const { user_id, room_id, genres, years } = req.body;

    try {
        // Сохраняем предпочтения в user_preferences
        const { error: insertError } = await supabase
            .from('user_preferences')
            .insert({ user_id, room_id, genres, years });

        if (insertError) {
            console.error('Error inserting preferences:', insertError);
            return res.status(500).json({ error: 'Failed to save preferences' });
        }

        // Проверяем, все ли пользователи в комнате отправили предпочтения
        const { data: preferences, error: fetchError } = await supabase
            .from('user_preferences')
            .select('*')
            .eq('room_id', room_id);

        if (fetchError) {
            console.error('Error fetching preferences:', fetchError);
            return res.status(500).json({ error: 'Failed to fetch preferences' });
        }

        const { data: users, error: usersError } = await supabase
            .from('user_sessions')
            .select('user_id')
            .eq('room_id', room_id)
            .eq('is_online', true);

        if (usersError) {
            console.error('Error fetching users:', usersError);
            return res.status(500).json({ error: 'Failed to fetch users' });
        }

        // Если все пользователи отправили предпочтения
        if (preferences.length === users.length && preferences.length > 0) {
            // Объединяем жанры (уникальный список)
            const allGenres = [...new Set(preferences.flatMap(p => p.genres))];
            // Находим пересечение годов
            const startYears = preferences.map(p => p.years[0]);
            const endYears = preferences.map(p => p.years[1]);
            const yearRange = `${Math.max(...startYears)}-${Math.min(...endYears)}`;

            // Формируем запрос к API Кинопоиска
            const params = new URLSearchParams();
            params.append('page', '1');
            params.append('limit', '15');
            params.append('year', yearRange);
            allGenres.forEach(genre => params.append('genres.name', genre));
            ['id', 'name', 'year', 'movieLength', 'rating', 'description', 'genres', 'poster'].forEach(field => params.append('selectFields', field));
            ['name', 'description', 'poster.url'].forEach(field => params.append('notNullFields', field));
            params.append('sortField', 'rating.kp');
            params.append('sortType', '-1');
            params.append('type', 'movie');

            try {
                const response = await axios.get(`https://api.kinopoisk.dev/v1.4/movie?${params.toString()}`, {
                    headers: { 'X-API-KEY': process.env.KINOPOISK_API_KEY }
                });

                const movies = response.data.docs;

                // Сохраняем результаты в room_results
                const { error: resultError } = await supabase
                    .from('room_results')
                    .insert({ room_id, movies });

                if (resultError) {
                    console.error('Error saving results:', resultError);
                    return res.status(500).json({ error: 'Failed to save results' });
                }

                return res.json({ status: 'ready' });
            } catch (apiError) {
                console.error('Error calling Kinopoisk API:', apiError);
                return res.status(500).json({ error: 'Failed to fetch movies from Kinopoisk' });
            }
        }

        return res.json({ status: 'waiting' });
    } catch (error) {
        console.error('Server error:', error);
        return res.status(500).json({ error: 'Server error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));